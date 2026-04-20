import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { Effect, Layer } from "effect"
import matter from "gray-matter"
import { VaultError } from "../errors.js"
import { VaultService, type WikiPage } from "../services/VaultService.js"

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
          const files = await walkMarkdown(vaultDir, ["wiki", "theses", "briefs"])
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
  })
