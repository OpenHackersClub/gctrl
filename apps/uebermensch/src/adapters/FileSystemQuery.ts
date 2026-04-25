import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError } from "../errors.js"
import { PromptFrontmatter } from "../schemas.js"
import {
  type Prompt,
  type PromptStamp,
  type PromptStatus,
  QueryService,
} from "../services/QueryService.js"

const PROMPTS_DIR = "prompts"

const slugify = (stem: string): string =>
  stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")

const titlize = (stem: string): string =>
  stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())

type Loaded = {
  readonly absPath: string
  readonly relPath: string
  readonly raw: string
  readonly parsed: matter.GrayMatterFile<string>
}

const loadAll = (vaultDir: string): Effect.Effect<ReadonlyArray<Loaded>, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      const root = join(vaultDir, PROMPTS_DIR)
      let entries: Array<import("node:fs").Dirent>
      try {
        entries = await readdir(root, { recursive: true, withFileTypes: true })
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === "ENOENT") return []
        throw e
      }
      const out: Array<Loaded> = []
      for (const e of entries) {
        if (!e.isFile()) continue
        if (extname(e.name).toLowerCase() !== ".md") continue
        const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? root
        const abs = join(parent, e.name)
        const raw = await readFile(abs, "utf8")
        out.push({ absPath: abs, relPath: relative(vaultDir, abs), raw, parsed: matter(raw) })
      }
      return out
    },
    catch: (e) =>
      new VaultError({
        message: `list prompts failed: ${String(e)}`,
        path: vaultDir,
        kind: "io_failure",
      }),
  })

const decodePrompt = (l: Loaded): Effect.Effect<Prompt, VaultError> =>
  Effect.gen(function* () {
    const data = (l.parsed.data ?? {}) as Record<string, unknown>
    const decoded = yield* Schema.decodeUnknown(PromptFrontmatter)(data).pipe(
      Effect.mapError(
        (e) =>
          new VaultError({
            message: `prompt ${l.relPath} invalid frontmatter: ${String(e)}`,
            path: l.absPath,
            kind: "parse_failure",
          }),
      ),
    )
    const stem = basename(l.absPath, ".md")
    const slug = decoded.slug ?? slugify(stem)
    if (slug.length === 0) {
      return yield* Effect.fail(
        new VaultError({
          message: `prompt ${l.relPath} produced empty slug`,
          path: l.absPath,
          kind: "parse_failure",
        }),
      )
    }
    const status: PromptStatus = decoded.status ?? "pending"
    return {
      slug,
      title: decoded.title ?? titlize(stem),
      topics: decoded.topics ?? [],
      status,
      body: l.parsed.content,
      relPath: l.relPath,
      absPath: l.absPath,
      output: decoded.output ?? null,
      processedAt: decoded.processed_at ?? null,
      contentHash: decoded.content_hash ?? null,
      promptHash: decoded.prompt_hash ?? null,
      model: decoded.model ?? null,
    }
  })

const writeStamped = async (
  l: Loaded,
  stamp: PromptStamp,
): Promise<void> => {
  const data = (l.parsed.data ?? {}) as Record<string, unknown>
  const next: Record<string, unknown> = {
    ...data,
    status: stamp.status,
    processed_at: stamp.processedAt,
  }
  if (stamp.output !== undefined) next.output = stamp.output
  if (stamp.contentHash !== undefined) next.content_hash = stamp.contentHash
  if (stamp.promptHash !== undefined) next.prompt_hash = stamp.promptHash
  if (stamp.model !== undefined) next.model = stamp.model
  if (stamp.costUsd !== undefined) next.cost_usd = stamp.costUsd
  if (stamp.failedReason !== undefined) next.failed_reason = stamp.failedReason
  // Drop stale failure reason on success
  if (stamp.status === "processed" && stamp.failedReason === undefined) {
    delete next.failed_reason
  }
  const rebuilt = matter.stringify(l.parsed.content, next)
  const tmpPath = `${l.absPath}.tmp-${process.pid}-${Date.now()}`
  await mkdir(join(l.absPath, ".."), { recursive: true })
  await writeFile(tmpPath, rebuilt, "utf8")
  await rename(tmpPath, l.absPath)
}

export const FileSystemQueryLive = (vaultDir: string) =>
  Layer.succeed(QueryService, {
    list: () =>
      Effect.gen(function* () {
        const loaded = yield* loadAll(vaultDir)
        const out: Array<Prompt> = []
        for (const l of loaded) out.push(yield* decodePrompt(l))
        return out
      }),
    get: (slug) =>
      Effect.gen(function* () {
        const loaded = yield* loadAll(vaultDir)
        for (const l of loaded) {
          const p = yield* decodePrompt(l)
          if (p.slug === slug) return p
        }
        return yield* Effect.fail(
          new VaultError({
            message: `prompt not found: ${slug}`,
            path: join(vaultDir, PROMPTS_DIR),
            kind: "not_found",
          }),
        )
      }),
    stamp: (slug, stamp) =>
      Effect.gen(function* () {
        const loaded = yield* loadAll(vaultDir)
        for (const l of loaded) {
          const p = yield* decodePrompt(l)
          if (p.slug !== slug) continue
          // Re-stat to make sure the file wasn't replaced under us
          yield* Effect.tryPromise({
            try: () => stat(l.absPath),
            catch: (e) =>
              new VaultError({
                message: `stat failed: ${String(e)}`,
                path: l.absPath,
                kind: "io_failure",
              }),
          })
          return yield* Effect.tryPromise({
            try: () => writeStamped(l, stamp),
            catch: (e) =>
              new VaultError({
                message: `stamp prompt failed: ${String(e)}`,
                path: l.absPath,
                kind: "io_failure",
              }),
          })
        }
        return yield* Effect.fail(
          new VaultError({
            message: `prompt not found: ${slug}`,
            path: join(vaultDir, PROMPTS_DIR),
            kind: "not_found",
          }),
        )
      }),
  })
