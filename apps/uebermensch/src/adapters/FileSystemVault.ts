import { readFile, readdir, stat } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError } from "../errors.js"
import {
  DIRECTIVES_RESEARCH_DIR,
  DIRECTIVES_THESES_DIR,
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_REPORTS_DIR,
  INPUT_WIKI_DIR,
} from "../lib/vault-paths.js"
import { ResearchInterestFrontmatter } from "../schemas.js"
import {
  VaultService,
  type ResearchInterest,
  type ThesisRef,
  type WikiPage,
} from "../services/VaultService.js"
import { VaultWriterPort } from "../services/VaultWriterPort.js"
import { FsVaultWriterLive } from "./FsVaultWriter.js"
import { vaultSecretGuard } from "./VaultSecretGuard.js"

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

// Wiki + raw source pages + theses are the candidate set the curator + sinkin
// passes see. Briefs and reports are CoS-curated output for the user, not
// candidate knowledge — they are NOT included in listWikiPages or
// recentlyChanged.
const KB_DIRS = [INPUT_WIKI_DIR, INPUT_RAW_DIR, DIRECTIVES_THESES_DIR] as const

// listSlugs is used for citation resolution — every file whose stem can appear
// inside a [[wikilink]]. That covers the knowledge graph plus briefs/reports
// (a brief or report can [[link]] to another brief).
const SLUG_DIRS = [
  INPUT_WIKI_DIR,
  INPUT_RAW_DIR,
  DIRECTIVES_THESES_DIR,
  INPUT_BRIEFS_DIR,
  INPUT_REPORTS_DIR,
] as const

// VaultService implementation that depends on VaultWriterPort for all writes.
// Read-side methods (listWikiPages, recentlyChanged, listSlugs,
// listResearchInterests) walk the filesystem directly — they have a typed
// shape that doesn't fit VaultWriterPort.list, and reads are not subject to
// secret-leak scanning.
const VaultServiceFromWriter = (vaultDir: string) =>
  Layer.effect(
    VaultService,
    Effect.gen(function* () {
      const writer = yield* VaultWriterPort

      return {
        root: () => vaultDir,
        listWikiPages: () =>
          Effect.tryPromise({
            try: async () => {
              const files = await walkMarkdown(vaultDir, KB_DIRS)
              return Promise.all(files.map(loadPage))
            },
            catch: (e) =>
              new VaultError({ message: `list wiki failed: ${String(e)}`, path: vaultDir }),
          }),
        recentlyChanged: (sinceHours) =>
          Effect.tryPromise({
            try: async () => {
              const cutoff = Date.now() - sinceHours * 3_600_000
              const files = await walkMarkdown(vaultDir, KB_DIRS)
              const recent = files.filter((f) => f.stat.mtime.getTime() >= cutoff)
              return Promise.all(recent.map(loadPage))
            },
            catch: (e) =>
              new VaultError({ message: `recent scan failed: ${String(e)}`, path: vaultDir }),
          }),
        listSlugs: () =>
          Effect.tryPromise({
            try: async () => {
              const files = await walkMarkdown(vaultDir, SLUG_DIRS)
              const slugs = new Set<string>()
              for (const f of files) slugs.add(basename(f.abs, ".md"))
              return slugs as ReadonlySet<string>
            },
            catch: (e) =>
              new VaultError({ message: `list slugs failed: ${String(e)}`, path: vaultDir }),
          }),
        writeBrief: (date, content) =>
          Effect.gen(function* () {
            const relPath = `${INPUT_BRIEFS_DIR}/${date}.md`
            const written = yield* writer.write(relPath, content)
            return {
              absPath: join(vaultDir, relPath),
              relPath,
              contentHash: written.contentHash,
            }
          }),
        listResearchInterests: () =>
          Effect.gen(function* () {
            const files = yield* Effect.tryPromise({
              try: () => walkMarkdown(vaultDir, [DIRECTIVES_RESEARCH_DIR]),
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
                fieldFamiliarity: decoded.field_familiarity ?? "expert",
                notes: parsed.content.trim(),
                relPath: f.rel,
              })
            }
            return out
          }),
        listTheses: () =>
          Effect.tryPromise({
            try: async () => {
              const files = await walkMarkdown(vaultDir, [DIRECTIVES_THESES_DIR])
              const out: Array<ThesisRef> = []
              for (const f of files) {
                const raw = await readFile(f.abs, "utf8")
                const parsed = matter(raw)
                const fm = (parsed.data ?? {}) as Record<string, unknown>
                const stem = basename(f.abs, ".md")
                const slug = (fm.slug as string | undefined) ?? stem
                const title = (fm.title as string | undefined) ?? stem
                const topics =
                  (fm.topics as ReadonlyArray<string> | undefined) ?? []
                out.push({
                  slug,
                  title,
                  topics,
                  body: parsed.content,
                  relPath: f.rel,
                })
              }
              return out
            },
            catch: (e) =>
              new VaultError({
                message: `list theses failed: ${String(e)}`,
                path: vaultDir,
                kind: "io_failure",
              }),
          }),
        writeReport: (slug, content) =>
          Effect.gen(function* () {
            const relPath = `${INPUT_REPORTS_DIR}/${slug}.md`
            const written = yield* writer.write(relPath, content)
            return {
              absPath: join(vaultDir, relPath),
              relPath,
              contentHash: written.contentHash,
            }
          }),
        // Prompt-driven research answers also land in input/reports/ — they
        // are CoS output the user reads. Kept as a distinct method so
        // prompts.ts can stay readable; it just delegates.
        writeResearch: (slug, content) =>
          Effect.gen(function* () {
            const relPath = `${INPUT_REPORTS_DIR}/${slug}.md`
            const written = yield* writer.write(relPath, content)
            return {
              absPath: join(vaultDir, relPath),
              relPath,
              contentHash: written.contentHash,
            }
          }),
        writeSource: (slug, content, options) =>
          Effect.gen(function* () {
            const relPath = `${INPUT_RAW_DIR}/${slug}.md`
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

            const written = yield* writer.write(relPath, content)
            return {
              absPath,
              relPath,
              contentHash: written.contentHash,
              existed,
            }
          }),
      }
    }),
  )

// FileSystemVaultLive bundles VaultService + VaultSecretGuard + FsVaultWriter
// into a single Layer with no remaining requirements. Call sites continue to
// `Effect.provide(FileSystemVaultLive(vaultDir))` and the secret-leak guard is
// load-bearing on every write.
export const FileSystemVaultLive = (vaultDir: string): Layer.Layer<VaultService> =>
  VaultServiceFromWriter(vaultDir).pipe(
    Layer.provide(vaultSecretGuard(FsVaultWriterLive(vaultDir))),
  )
