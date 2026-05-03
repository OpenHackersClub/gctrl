// vault migrate-citations — Citation Mode v1 migration command.
//
// Hybrid migration strategy:
//   1. Bulk-redigest pages cited in any brief generated within the last
//      `--lookback-days` (default 30) — "high-traffic" pages.
//   2. Mark everything else with `pending_digest: true` so the normal ingest
//      loop picks them up lazily on next touch — "long-tail" pages.
//
// Pages that already have `digest_version >= 1` in frontmatter are skipped.
// Originals are archived under `--archive-dir` before any overwrite.
// Progress is logged to `input/archive/migration-citation-v1.ndjson`.

import { cp, mkdir, open, readFile, readdir, rename } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { createHash } from "node:crypto"
import { Command, Options } from "@effect/cli"
import { Console, Effect, Either } from "effect"
import matter from "gray-matter"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { VaultError, vaultIo } from "../errors.js"
import { resolveVaultDir } from "../lib/env.js"
import { renderSourceBody } from "../lib/source-body.js"
import { INPUT_BRIEFS_DIR, INPUT_RAW_DIR } from "../lib/vault-paths.js"
import { LlmService } from "../services/LlmService.js"

// ---- option declarations ---------------------------------------------------

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Print what would happen; do not write (default: true)"),
  Options.withDefault(true),
)

const applyOpt = Options.boolean("apply").pipe(
  Options.withDescription("Required for actual writes (overrides --dry-run)"),
  Options.withDefault(false),
)

const lookbackDaysOpt = Options.integer("lookback-days").pipe(
  Options.withDescription(
    "Pages cited in any brief generated within this many days are considered high-traffic (default: 30)",
  ),
  Options.withDefault(30),
)

const maxOpt = Options.integer("max").pipe(
  Options.withDescription("Cap on high-traffic pages to bulk-redigest per run (default: 80)"),
  Options.withDefault(80),
)

const allOpt = Options.boolean("all").pipe(
  Options.withDescription(
    "Override lookback gate — redigest every un-migrated source page (default: false)",
  ),
  Options.withDefault(false),
)

const archiveDirOpt = Options.text("archive-dir").pipe(
  Options.withDescription(
    "Vault-relative path where originals are copied before overwrite (default: input/archive/raw-pre-digest/)",
  ),
  Options.withDefault("input/archive/raw-pre-digest/"),
)

// ---- types ------------------------------------------------------------------

export type MigrationProgramArgs = {
  readonly vaultDir: string
  readonly isDryRun: boolean
  readonly lookbackDays: number
  readonly max: number
  readonly all: boolean
  readonly archiveDir: string
}

type SourceEntry = {
  readonly absPath: string
  readonly slug: string
  readonly fm: Record<string, unknown>
  readonly body: string
}

// ---- helpers ----------------------------------------------------------------

const sha256Hex = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex")

/** Read all .md files under a directory recursively; returns abs paths. */
const walkMarkdownAbs = async (dir: string): Promise<Array<string>> => {
  const results: Array<string> = []
  let rawEntries: Array<{ isFile: () => boolean; name: string; path?: string; parentPath?: string }>
  try {
    rawEntries = (await readdir(dir, {
      recursive: true,
      withFileTypes: true,
      encoding: "utf8",
    })) as Array<{ isFile: () => boolean; name: string; path?: string; parentPath?: string }>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return results
    throw e
  }
  for (const e of rawEntries) {
    if (!e.isFile()) continue
    const name = String(e.name)
    if (extname(name).toLowerCase() !== ".md") continue
    const parent = e.parentPath ?? e.path ?? dir
    results.push(join(parent, name))
  }
  return results
}

/** Collect all source_page_ids and source_candidate_ids referenced by briefs
 *  generated on or after `cutoff`. Returns a Set<slug>. */
const collectHighTrafficSlugs = async (
  vaultDir: string,
  cutoff: Date,
): Promise<Set<string>> => {
  const slugs = new Set<string>()
  const briefsDir = join(vaultDir, INPUT_BRIEFS_DIR)
  const briefPaths = await walkMarkdownAbs(briefsDir)

  for (const p of briefPaths) {
    let raw: string
    try {
      raw = await readFile(p, "utf8")
    } catch {
      continue
    }
    const parsed = matter(raw)
    const fm = (parsed.data ?? {}) as Record<string, unknown>

    // Determine the brief date: prefer generated_for frontmatter, else
    // stem-based date (YYYY-MM-DD.md). Skip briefs older than the cutoff.
    const gf = fm.generated_for as string | Date | undefined
    if (gf) {
      const d = typeof gf === "string" ? new Date(gf) : gf
      if (!Number.isNaN(d.getTime()) && d < cutoff) continue
    } else {
      const stem = basename(p, ".md")
      if (/^\d{4}-\d{2}-\d{2}$/.test(stem)) {
        const fileDate = new Date(stem)
        if (!Number.isNaN(fileDate.getTime()) && fileDate < cutoff) continue
      }
      // No date found — include the brief conservatively (err on side of redigest).
    }

    // Collect source_page_ids from references[] inside items[]
    const items = (fm.items as Array<Record<string, unknown>> | undefined) ?? []
    for (const item of items) {
      const refs = (item.references as Array<Record<string, unknown>> | undefined) ?? []
      for (const ref of refs) {
        const spid = ref.source_page_id as string | undefined
        if (spid) slugs.add(spid)
      }
      // Also support legacy source_candidate_ids per item
      const scids = (item.source_candidate_ids as Array<string> | undefined) ?? []
      for (const id of scids) slugs.add(id)
    }

    // Top-level source_candidate_ids (pre-citation-mode brief format)
    const topLevelScids = (fm.source_candidate_ids as Array<string> | undefined) ?? []
    for (const id of topLevelScids) slugs.add(id)
  }

  return slugs
}

/** Write a string atomically (tmp → rename). */
const writeAtomic = async (absPath: string, content: string): Promise<void> => {
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
  await mkdir(dirname(absPath), { recursive: true })
  const fh = await open(tmpPath, "w")
  try {
    await fh.writeFile(content, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmpPath, absPath)
}

/** Append a single NDJSON line to the migration log. */
const appendMigrationLog = async (logPath: string, entry: object): Promise<void> => {
  await mkdir(dirname(logPath), { recursive: true })
  const line = JSON.stringify(entry) + "\n"
  const fh = await open(logPath, "a")
  try {
    await fh.writeFile(line, "utf8")
  } finally {
    await fh.close()
  }
}

/** Set `pending_digest: true` in frontmatter without changing the body. */
const setPendingDigest = async (absPath: string): Promise<void> => {
  const raw = await readFile(absPath, "utf8")
  const parsed = matter(raw)
  const fm = { ...(parsed.data ?? {}), pending_digest: true }
  const newContent = matter.stringify(parsed.content, fm)
  await writeAtomic(absPath, newContent)
}

// ---- core migration program (exported for testability) ---------------------

/**
 * Core migration Effect — requires LlmService.
 * Tests can provide a stub LlmService layer directly.
 * The CLI wrapper wraps this with KernelLlmLive.
 */
export const makeMigrationProgram = (
  args: MigrationProgramArgs,
): Effect.Effect<void, VaultError, LlmService> => {
  const { vaultDir, isDryRun, lookbackDays, max, all, archiveDir } = args

  return Effect.gen(function* () {
    if (isDryRun) {
      yield* Console.log("[dry-run] No files will be written.")
    }

    // 1. Scan input/raw/**/*.md
    const rawDir = join(vaultDir, INPUT_RAW_DIR)
    const allRawPaths = yield* vaultIo(
      () => walkMarkdownAbs(rawDir),
      { message: "scan input/raw failed", path: rawDir },
    )

    // 2. Parse frontmatter and skip already-digested pages
    const unmigratedEntries: Array<SourceEntry> = []

    for (const absPath of allRawPaths) {
      const raw = yield* vaultIo(
        () => readFile(absPath, "utf8"),
        { message: "read source page failed", path: absPath },
      )
      const parsed = matter(raw)
      const fm = (parsed.data ?? {}) as Record<string, unknown>
      const digestVersion = fm.digest_version as number | undefined
      if (digestVersion !== undefined && digestVersion >= 1) continue
      const slug = basename(absPath, ".md")
      unmigratedEntries.push({ absPath, slug, fm, body: parsed.content })
    }

    yield* Console.log(
      `Found ${allRawPaths.length} source pages; ${unmigratedEntries.length} un-migrated.`,
    )

    // 3. Bucket pages: high-traffic vs long-tail
    const now = new Date()
    const cutoff = new Date(now.getTime() - lookbackDays * 86_400_000)

    let highTrafficBatch: Array<SourceEntry>
    let longTailEntries: Array<SourceEntry>

    if (all) {
      // --all overrides lookback gate
      highTrafficBatch = unmigratedEntries.slice(0, max)
      longTailEntries = unmigratedEntries.slice(max)
      yield* Console.log(
        `--all flag set: ${highTrafficBatch.length} in batch, ${longTailEntries.length} deferred.`,
      )
    } else {
      const highTrafficSlugs = yield* vaultIo(
        () => collectHighTrafficSlugs(vaultDir, cutoff),
        { message: "scan briefs for citations failed", path: vaultDir },
      )
      yield* Console.log(
        `High-traffic slugs cited within last ${lookbackDays} days: ${highTrafficSlugs.size}`,
      )
      const highTrafficAll = unmigratedEntries.filter((e) => highTrafficSlugs.has(e.slug))
      longTailEntries = unmigratedEntries.filter((e) => !highTrafficSlugs.has(e.slug))
      highTrafficBatch = highTrafficAll.slice(0, max)
      if (highTrafficAll.length > max) {
        yield* Console.log(
          `Capping high-traffic batch at ${max} (${highTrafficAll.length - max} deferred to next run).`,
        )
      }
    }

    const absArchiveDir = join(vaultDir, archiveDir)
    const logPath = join(vaultDir, "input/archive/migration-citation-v1.ndjson")
    const digestedAt = now.toISOString()

    // 4. Process high-traffic pages via LLM
    let redigested = 0
    let errors = 0

    const llm = yield* LlmService

    for (const entry of highTrafficBatch) {
      const title = (entry.fm.title as string | undefined) ?? entry.slug
      const url = (entry.fm.url as string | undefined) ?? ""
      const topics = (
        (entry.fm.topics as ReadonlyArray<string> | undefined) ?? []
      ) as ReadonlyArray<string>

      yield* Console.log(
        `  [${isDryRun ? "dry-run" : "apply"}] redigest: ${entry.slug}`,
      )

      const result = yield* llm
        .summarizeSource({ title, url, topics, text: entry.body })
        .pipe(Effect.either)

      if (Either.isLeft(result)) {
        yield* Console.error(`    ✗ ${entry.slug} — LLM error: ${result.left.message}`)
        errors += 1
        continue
      }

      const summaryResp = result.right
      const digest = summaryResp.digest
      const { model, costUsd } = summaryResp
      // inputTokens/outputTokens are optional on the public interface
      const inputTokens =
        (summaryResp as unknown as { inputTokens?: number }).inputTokens ?? 0
      const outputTokens =
        (summaryResp as unknown as { outputTokens?: number }).outputTokens ?? 0

      // Build new file body via renderSourceBody (migration overload — digest only)
      const newBody = renderSourceBody(digest)
      const newFm: Record<string, unknown> = {
        ...entry.fm,
        digest_version: 1,
        pending_digest: false,
        summary: {
          model,
          digested_at: digestedAt,
          cost_usd: costUsd,
        },
      }
      const newContent = matter.stringify(`\n${newBody}`, newFm)
      const newHash = `sha256:${sha256Hex(newContent)}`

      if (isDryRun) {
        const previewGist =
          Array.isArray(digest.gist) ? JSON.stringify(digest.gist.slice(0, 1)) : "(no gist)"
        yield* Console.log(
          `    old size=${entry.body.length} → new size=${newBody.length}, digest preview: ${previewGist}`,
        )
        redigested += 1
        continue
      }

      // --apply: archive original, write new file atomically, append log
      yield* vaultIo(
        async () => {
          await mkdir(absArchiveDir, { recursive: true })
          await cp(entry.absPath, join(absArchiveDir, `${entry.slug}.md`), { force: true })
        },
        { message: `archive ${entry.slug} failed`, path: entry.absPath },
      )

      yield* vaultIo(
        () => writeAtomic(entry.absPath, newContent),
        { message: `write migrated source ${entry.slug} failed`, path: entry.absPath },
      )

      yield* vaultIo(
        () =>
          appendMigrationLog(logPath, {
            slug: entry.slug,
            status: "digested",
            digest_version: 1,
            digested_at: digestedAt,
            model,
            cost_usd: costUsd,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            content_hash: newHash,
          }),
        { message: "append migration log failed", path: logPath },
      )

      yield* Console.log(`    ✓ archived + redigested (model=${model}, hash=${newHash})`)
      redigested += 1
    }

    // 5. Long-tail pages: mark pending_digest: true in --apply mode
    let markedPending = 0
    for (const entry of longTailEntries) {
      if (isDryRun) {
        yield* Console.log(`  [dry-run] mark pending: ${entry.slug}`)
        markedPending += 1
        continue
      }
      const r = yield* vaultIo(
        () => setPendingDigest(entry.absPath),
        {
          message: `mark pending_digest failed for ${entry.slug}`,
          path: entry.absPath,
        },
      ).pipe(Effect.either)
      if (Either.isLeft(r)) {
        yield* Console.error(`    ✗ ${entry.slug} — ${r.left.message}`)
        errors += 1
      } else {
        yield* Console.log(`  ✓ marked pending: ${entry.slug}`)
        markedPending += 1
      }
    }

    // 6. Summary
    yield* Console.log(
      `\nDone. ${redigested} high-traffic redigested, ${markedPending} long-tail marked pending, ${errors} errors.`,
    )
    if (errors > 0) {
      return yield* Effect.fail(
        new VaultError({
          message: `migration completed with ${errors} errors`,
          kind: "io_failure",
        }),
      )
    }
  })
}

// ---- command body -----------------------------------------------------------

export const vaultMigrateCitations = Command.make(
  "migrate-citations",
  { dryRunOpt, applyOpt, lookbackDaysOpt, maxOpt, allOpt, archiveDirOpt },
  ({
    dryRunOpt: dryRun,
    applyOpt: apply,
    lookbackDaysOpt: lookbackDays,
    maxOpt: max,
    allOpt: all,
    archiveDirOpt: archiveDir,
  }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      // --apply overrides --dry-run
      const doWrite = apply || !dryRun
      const isDryRun = !doWrite

      yield* makeMigrationProgram({
        vaultDir,
        isDryRun,
        lookbackDays,
        max,
        all,
        archiveDir,
      }).pipe(Effect.provide(KernelLlmLive))
    }),
).pipe(
  Command.withDescription(
    "Migrate source pages to Citation Mode v1 — bulk-redigest high-traffic, mark long tail pending",
  ),
)
