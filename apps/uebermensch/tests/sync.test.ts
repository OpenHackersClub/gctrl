import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { R2SyncConfigTag, R2SyncLive } from "../src/adapters/R2Sync.js"
import { SyncService } from "../src/services/SyncService.js"

// A fake wrangler that writes its stdin to a log file so we can count uploads
// without hitting the network.
const makeFakeWrangler = async (logDir: string) => {
  const log = join(logDir, "fake-wrangler.log")
  const script = join(logDir, "fake-wrangler.js")
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs')
const chunks = []
process.stdin.on('data', (d) => chunks.push(d))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), bytes: Buffer.concat(chunks).length}) + '\\n')
  process.exit(0)
})
`,
    { mode: 0o755 },
  )
  return { cmd: ["node", script] as const, log }
}

const seedVault = async (dir: string) => {
  await mkdir(join(dir, "reports"), { recursive: true })
  await mkdir(join(dir, "wiki", "sources"), { recursive: true })
  await writeFile(join(dir, "reports", "2026-W17.md"), "# Weekly\n", "utf8")
  await writeFile(join(dir, "wiki", "sources", "a.md"), "# A\n", "utf8")
  await writeFile(join(dir, "wiki", "sources", "b.md"), "# B\n", "utf8")
}

const runSync = (vaultDir: string, wranglerCmd: ReadonlyArray<string>, opts: { force?: boolean; dryRun?: boolean } = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* SyncService
      return yield* sync.run({
        vaultDir,
        prefixes: ["reports", "wiki/sources"],
        dryRun: opts.dryRun ?? false,
        force: opts.force ?? false,
      })
    }).pipe(
      Effect.provide(
        R2SyncLive.pipe(
          Layer.provide(
            Layer.succeed(R2SyncConfigTag, {
              bucket: "gctrl-vault-test",
              wranglerCmd,
              concurrency: 2,
            }),
          ),
        ),
      ),
    ),
  )

describe("R2 sync dedup via local manifest", () => {
  it("first run uploads every file; second run skips all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-sync-"))
    await seedVault(dir)
    const { cmd, log } = await makeFakeWrangler(dir)

    const first = await runSync(dir, cmd)
    expect(first.uploaded).toBe(3)
    expect(first.skipped).toBe(0)
    expect(first.failed).toBe(0)

    const logContents1 = await readFile(log, "utf8")
    expect(logContents1.trim().split("\n")).toHaveLength(3)

    const manifest = JSON.parse(
      await readFile(join(dir, ".uber-sync-state.json"), "utf8"),
    )
    expect(manifest.version).toBe(1)
    expect(Object.keys(manifest.entries)).toHaveLength(3)

    const second = await runSync(dir, cmd)
    expect(second.uploaded).toBe(0)
    expect(second.skipped).toBe(3)
    expect(second.failed).toBe(0)

    // No new wrangler invocations.
    const logContents2 = await readFile(log, "utf8")
    expect(logContents2.trim().split("\n")).toHaveLength(3)
  })

  it("re-uploads only files whose sha256 changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-sync-"))
    await seedVault(dir)
    const { cmd, log } = await makeFakeWrangler(dir)

    await runSync(dir, cmd) // seed manifest

    await writeFile(join(dir, "reports", "2026-W17.md"), "# Weekly — edited\n", "utf8")

    const second = await runSync(dir, cmd)
    expect(second.uploaded).toBe(1)
    expect(second.skipped).toBe(2)
    expect(second.failed).toBe(0)

    const logLines = (await readFile(log, "utf8")).trim().split("\n")
    // 3 (initial) + 1 (re-upload edited file) = 4
    expect(logLines).toHaveLength(4)
  })

  it("--force bypasses the manifest and re-uploads everything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-sync-"))
    await seedVault(dir)
    const { cmd, log } = await makeFakeWrangler(dir)

    await runSync(dir, cmd)

    const forced = await runSync(dir, cmd, { force: true })
    expect(forced.uploaded).toBe(3)
    expect(forced.skipped).toBe(0)

    const logLines = (await readFile(log, "utf8")).trim().split("\n")
    expect(logLines).toHaveLength(6) // 3 + 3
  })

  it("--dry-run uploads nothing and does not write the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-sync-"))
    await seedVault(dir)
    const { cmd, log } = await makeFakeWrangler(dir)

    const result = await runSync(dir, cmd, { dryRun: true })
    expect(result.uploaded).toBe(3) // would-be uploads counted
    expect(result.skipped).toBe(0)

    // Fake wrangler not invoked.
    const logExists = await readFile(log, "utf8").catch(() => "")
    expect(logExists).toBe("")

    // No manifest written (nothing to track yet).
    const hasManifest = await readFile(join(dir, ".uber-sync-state.json"), "utf8").then(
      () => true,
      () => false,
    )
    expect(hasManifest).toBe(false)
  })
})
