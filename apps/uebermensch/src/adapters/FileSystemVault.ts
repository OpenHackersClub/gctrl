import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError } from "../errors.js"
import { ResearchInterestFrontmatter } from "../schemas.js"
import {
  VaultService,
  type ResearchInterest,
  type WikiPage,
} from "../services/VaultService.js"

const hashContent = (s: string) =>
  `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`

type WalkEntry = { abs: string; rel: string; stat: Awaited<ReturnType<typeof stat>> }

const walkMarkdown = async (
  root: string,
  subdirs: ReadonlyArray<string>,
): Promise<Array<WalkEntry>> => {
  const pages: Array<WalkEntry> = []
  for (const sub of subdirs) {
    const start = join(root, sub)
    try {
      const entries = await readdir(start, { recursive: true, withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        if (extname(e.name).toLowerCase() !== ".md") continue
        const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? start
        const abs = join(parent, e.name)
        const st = await stat(abs)
        pages.push({ abs, rel: relative(root, abs), stat: st })
      }
    } catch {
      // subdir missing — skip
    }
  }
  return pages
}

const loadPage = async (entry: WalkEntry): Promise<WikiPage> => {
  const raw = await readFile(entry.abs, "utf8")
  const parsed = matter(raw)
  return {
    relPath: entry.rel,
    stem: basename(entry.abs, ".md"),
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content,
    mtime: entry.stat.mtime,
  }
}

export const FileSystemVaultLive = (vaultDir: string) =>
  Layer.succeed(VaultService, {
    root: () => vaultDir,
    listWikiPages: () =>
      Effect.tryPromise({
        try: async () => {
          const files = await walkMarkdown(vaultDir, ["wiki", "theses"])
          return Promise.all(files.map(loadPage))
        },
        catch: (e) =>
          new VaultError({ message: `list wiki failed: ${String(e)}`, path: vaultDir }),
      }),
    recentlyChanged: (sinceHours) =>
      Effect.tryPromise({
        try: async () => {
          const cutoff = Date.now() - sinceHours * 3_600_000
          const files = await walkMarkdown(vaultDir, ["wiki", "theses"])
          const recent = files.filter((f) => f.stat.mtime.getTime() >= cutoff)
          return Promise.all(recent.map(loadPage))
        },
        catch: (e) =>
          new VaultError({ message: `recent scan failed: ${String(e)}`, path: vaultDir }),
      }),
    listSlugs: () =>
      Effect.tryPromise({
        try: async () => {
          const files = await walkMarkdown(vaultDir, [
            "wiki",
            "theses",
            "briefs",
            "reports",
          ])
          const slugs = new Set<string>()
          for (const f of files) slugs.add(basename(f.abs, ".md"))
          return slugs as ReadonlySet<string>
        },
        catch: (e) =>
          new VaultError({ message: `list slugs failed: ${String(e)}`, path: vaultDir }),
      }),
    writeBrief: (date, content) =>
      Effect.tryPromise({
        try: async () => {
          const relPath = `briefs/${date}.md`
          const absPath = join(vaultDir, relPath)
          const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
          await mkdir(join(vaultDir, "briefs"), { recursive: true })
          await writeFile(tmpPath, content, "utf8")
          await rename(tmpPath, absPath)
          return { absPath, relPath, contentHash: hashContent(content) }
        },
        catch: (e) =>
          new VaultError({ message: `write brief failed: ${String(e)}`, path: vaultDir }),
      }),
    listResearchInterests: () =>
      Effect.gen(function* () {
        const files = yield* Effect.tryPromise({
          try: () => walkMarkdown(vaultDir, ["research"]),
          catch: (e) =>
            new VaultError({
              message: `list research failed: ${String(e)}`,
              path: vaultDir,
              kind: "io_failure",
            }),
        })
        const out: Array<ResearchInterest> = []
        for (const f of files) {
          const raw = yield* Effect.tryPromise({
            try: () => readFile(f.abs, "utf8"),
            catch: (e) =>
              new VaultError({
                message: `read research file failed: ${String(e)}`,
                path: f.abs,
                kind: "io_failure",
              }),
          })
          const parsed = matter(raw)
          const data = (parsed.data ?? {}) as Record<string, unknown>
          const decoded = yield* Schema.decodeUnknown(ResearchInterestFrontmatter)(data).pipe(
            Effect.mapError(
              (e) =>
                new VaultError({
                  message: `research interest ${f.rel} invalid: ${String(e)}`,
                  path: f.abs,
                  kind: "parse_failure",
                }),
            ),
          )
          out.push({
            slug: decoded.slug,
            title: decoded.title,
            question: decoded.question ?? null,
            topics: decoded.topics,
            sources: decoded.sources ?? [],
            horizon: decoded.horizon ?? null,
            weight: decoded.weight ?? null,
            notes: parsed.content.trim(),
            relPath: f.rel,
          })
        }
        return out
      }),
    writeReport: (slug, content) =>
      Effect.tryPromise({
        try: async () => {
          const relPath = `reports/${slug}.md`
          const absPath = join(vaultDir, relPath)
          const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
          await mkdir(join(vaultDir, "reports"), { recursive: true })
          await writeFile(tmpPath, content, "utf8")
          await rename(tmpPath, absPath)
          return { absPath, relPath, contentHash: hashContent(content) }
        },
        catch: (e) =>
          new VaultError({
            message: `write report failed: ${String(e)}`,
            path: vaultDir,
            kind: "io_failure",
          }),
      }),
    writeSource: (slug, content, options) =>
      Effect.gen(function* () {
        const relPath = `wiki/sources/${slug}.md`
        const absPath = join(vaultDir, relPath)

        const existed = yield* Effect.tryPromise({
          try: async () => {
            try {
              await stat(absPath)
              return true
            } catch {
              return false
            }
          },
          catch: (e) =>
            new VaultError({
              message: `stat failed: ${String(e)}`,
              path: absPath,
              kind: "io_failure",
            }),
        })

        if (existed && !options?.overwrite) {
          return yield* Effect.fail(
            new VaultError({
              message: `source page already exists: ${relPath}`,
              path: absPath,
              kind: "collision",
            }),
          )
        }

        return yield* Effect.tryPromise({
          try: async () => {
            const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
            await mkdir(join(vaultDir, "wiki", "sources"), { recursive: true })
            await writeFile(tmpPath, content, "utf8")
            await rename(tmpPath, absPath)
            return { absPath, relPath, contentHash: hashContent(content), existed }
          },
          catch: (e) =>
            new VaultError({
              message: `write source failed: ${String(e)}`,
              path: absPath,
              kind: "io_failure",
            }),
        })
      }),
  })
