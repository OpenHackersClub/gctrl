import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  SyncError,
  SyncService,
  type SyncInput,
  type SyncPlanEntry,
  type SyncResult,
} from "../services/SyncService.js"

const MANIFEST_FILENAME = ".uber-sync-state.json"

type ManifestEntry = { readonly sha256: string; readonly uploadedAt: string }
type Manifest = { readonly version: 1; readonly entries: Record<string, ManifestEntry> }

const emptyManifest = (): Manifest => ({ version: 1, entries: {} })

const loadManifest = async (vaultDir: string): Promise<Manifest> => {
  try {
    const raw = await readFile(join(vaultDir, MANIFEST_FILENAME), "utf8")
    const parsed = JSON.parse(raw) as Partial<Manifest>
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyManifest()
    }
    return { version: 1, entries: parsed.entries as Record<string, ManifestEntry> }
  } catch {
    return emptyManifest()
  }
}

const saveManifest = async (vaultDir: string, m: Manifest): Promise<void> => {
  const abs = join(vaultDir, MANIFEST_FILENAME)
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, "utf8")
  await rename(tmp, abs)
}

export type R2SyncConfig = {
  readonly bucket: string
  // Command + args to invoke wrangler. Default: `pnpm dlx wrangler@latest`.
  readonly wranglerCmd?: ReadonlyArray<string>
  readonly concurrency?: number
}

export class R2SyncConfigTag extends Context.Tag("uebermensch/R2SyncConfig")<
  R2SyncConfigTag,
  R2SyncConfig
>() {}

const DEFAULT_CMD: ReadonlyArray<string> = ["pnpm", "dlx", "wrangler@latest"]

const sha256Of = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex")

const walkMd = async (root: string, prefixes: ReadonlyArray<string>) => {
  const out: Array<{ abs: string; key: string; size: number }> = []
  for (const sub of prefixes) {
    const start = join(root, sub)
    try {
      const entries = await readdir(start, { recursive: true, withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        if (!e.name.endsWith(".md")) continue
        const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? start
        const abs = join(parent, e.name)
        const st = await stat(abs)
        const key = relative(root, abs).split("/").join("/")
        out.push({ abs, key, size: st.size })
      }
    } catch {
      // prefix missing — skip
    }
  }
  return out
}

type RunResult = { code: number; stdout: string; stderr: string }

const runCmd = (cmd: string, args: ReadonlyArray<string>, opts: { input?: Buffer } = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    const outChunks: Array<Buffer> = []
    const errChunks: Array<Buffer> = []
    child.stdout.on("data", (d: Buffer) => outChunks.push(d))
    child.stderr.on("data", (d: Buffer) => errChunks.push(d))
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      }),
    )
    if (opts.input) {
      child.stdin.end(opts.input)
    } else {
      child.stdin.end()
    }
  })

const putObject = async (
  wrangler: ReadonlyArray<string>,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> => {
  const [cmd, ...base] = wrangler
  if (!cmd) throw new Error("empty wrangler command")
  const args = [
    ...base,
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--pipe",
    "--remote",
    "--content-type",
    "text/markdown; charset=utf-8",
  ]
  const res = await runCmd(cmd, args, { input: body })
  if (res.code !== 0) {
    throw new Error(
      `wrangler r2 object put exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    )
  }
}

const syncErr = (
  kind: SyncError["kind"],
  message: string,
  key?: string,
): SyncError => new SyncError({ kind, message, key })

const runSync = async (
  cfg: R2SyncConfig,
  input: SyncInput,
  onProgress: (entry: SyncPlanEntry) => void,
): Promise<SyncResult> => {
  const wrangler = cfg.wranglerCmd ?? DEFAULT_CMD
  const files = await walkMd(input.vaultDir, input.prefixes)
  const manifest = input.force ? emptyManifest() : await loadManifest(input.vaultDir)
  const nextManifest: Manifest = { version: 1, entries: { ...manifest.entries } }

  const entries: Array<SyncPlanEntry> = []
  let uploaded = 0
  let skipped = 0
  let failed = 0

  const concurrency = cfg.concurrency ?? 3
  let next = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= files.length) return
      const f = files[i]
      try {
        const buf = await readFile(f.abs)
        const sha = sha256Of(buf)
        const prior = manifest.entries[f.key]
        const unchanged = prior !== undefined && prior.sha256 === sha

        if (unchanged && !input.force) {
          const entry: SyncPlanEntry = {
            absPath: f.abs,
            key: f.key,
            sizeBytes: f.size,
            sha256: sha,
            action: "skip",
            remoteSha256: prior.sha256,
          }
          entries.push(entry)
          onProgress(entry)
          skipped += 1
          continue
        }

        if (!input.dryRun) {
          await putObject(wrangler, cfg.bucket, f.key, buf)
          nextManifest.entries[f.key] = { sha256: sha, uploadedAt: new Date().toISOString() }
        }
        const entry: SyncPlanEntry = {
          absPath: f.abs,
          key: f.key,
          sizeBytes: f.size,
          sha256: sha,
          action: "upload",
          remoteSha256: prior?.sha256 ?? null,
        }
        entries.push(entry)
        onProgress(entry)
        uploaded += 1
      } catch {
        failed += 1
      }
    }
  })
  await Promise.all(workers)

  if (!input.dryRun && (uploaded > 0 || Object.keys(manifest.entries).length === 0)) {
    await saveManifest(input.vaultDir, nextManifest)
  }
  return { uploaded, skipped, failed, entries }
}

export const R2SyncLive = Layer.effect(
  SyncService,
  Effect.gen(function* () {
    const cfg = yield* R2SyncConfigTag
    return {
      run: (input) =>
        Effect.async<SyncResult, SyncError>((resume) => {
          const log = (entry: SyncPlanEntry) => {
            // Skipped files are silent by default — summary line shows the count.
            // Show them in dry-run so the plan is auditable.
            if (entry.action === "skip" && !input.dryRun) return
            const tag = input.dryRun ? `[dry-run] ${entry.action}` : entry.action === "upload" ? "✓ upload" : "- skip"
            // eslint-disable-next-line no-console
            console.log(
              `  ${tag} ${entry.key} (${entry.sizeBytes}B sha=${entry.sha256.slice(0, 12)}…)`,
            )
          }
          runSync(cfg, input, log).then(
            (r) => resume(Effect.succeed(r)),
            (e) => resume(Effect.fail(syncErr("unreachable", `r2 sync failed: ${String(e)}`))),
          )
        }),
    }
  }),
)

const configFromEnv = (): R2SyncConfig => {
  const bucket = process.env.R2_BUCKET ?? "gctrl-vault"
  const concurrency = Number(process.env.R2_SYNC_CONCURRENCY ?? "3")
  return {
    bucket,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 3,
  }
}

export const R2SyncConfigFromEnv = Layer.sync(R2SyncConfigTag, configFromEnv)
