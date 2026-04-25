import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError } from "../errors.js"
import { matchesFilter, sortByStart } from "../lib/calendar-filter.js"
import { EventFrontmatter } from "../schemas.js"
import {
  CalendarService,
  type CalendarEvent,
  type EventAddInput,
  type EventStamp,
} from "../services/CalendarService.js"

const CALENDAR_DIR = "calendar"
const RECURRING_SUBDIR = "recurring" // deferred — see calendar.md open question #2
const GENERATOR = "gctrl-uber-cli"

const hashContent = (s: string): string =>
  `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)

const datePart = (startsAt: string): string => {
  // Accept bare YYYY-MM-DD or full ISO 8601; emit YYYY-MM-DD.
  const bare = startsAt.match(/^(\d{4}-\d{2}-\d{2})/)
  if (bare) return bare[1]
  const d = new Date(startsAt)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid starts_at: ${startsAt}`)
  }
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

type WalkEntry = { abs: string; rel: string }

// Walk calendar/ recursively, skipping the recurring/ subdir for the first slice.
const walkCalendar = async (
  root: string,
): Promise<ReadonlyArray<WalkEntry>> => {
  const start = join(root, CALENDAR_DIR)
  const out: Array<WalkEntry> = []
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = await readdir(start, { recursive: true, withFileTypes: true })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") return []
    throw e
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (extname(e.name).toLowerCase() !== ".md") continue
    const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? start
    const abs = join(parent, e.name)
    const rel = relative(root, abs)
    // Skip recurring/ files until RRULE expansion is implemented.
    const insideRecurring = rel.split("/").includes(RECURRING_SUBDIR)
    if (insideRecurring) continue
    out.push({ abs, rel })
  }
  return out
}

// js-yaml auto-converts ISO 8601 strings to Date objects unless they're
// quoted in the source. Normalise Date values back to ISO strings so the
// schema (which expects strings) decodes hand-authored Obsidian files cleanly.
const normaliseDates = (v: unknown): unknown => {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(normaliseDates)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normaliseDates(val)
    }
    return out
  }
  return v
}

const decodeEvent = (
  entry: WalkEntry,
  raw: string,
): Effect.Effect<CalendarEvent, VaultError> =>
  Effect.gen(function* () {
    const parsed = matter(raw)
    const data = normaliseDates((parsed.data ?? {}) as Record<string, unknown>) as Record<
      string,
      unknown
    >
    const decoded = yield* Schema.decodeUnknown(EventFrontmatter)(data).pipe(
      Effect.mapError(
        (e) =>
          new VaultError({
            message: `event ${entry.rel} invalid frontmatter: ${String(e)}`,
            path: entry.abs,
            kind: "parse_failure",
          }),
      ),
    )
    return {
      slug: decoded.slug,
      title: decoded.title,
      kind: decoded.kind,
      source: decoded.source,
      startsAt: decoded.starts_at,
      endsAt: decoded.ends_at ?? null,
      allDay: decoded.all_day ?? false,
      tz: decoded.tz,
      status: decoded.status,
      location: decoded.location ?? null,
      tickers: decoded.tickers ?? [],
      topics: decoded.topics ?? [],
      theses: decoded.theses ?? [],
      tags: decoded.tags ?? [],
      links: (decoded.links ?? []).map((l) => ({ title: l.title, url: l.url })),
      relatedPages: decoded.related_pages ?? [],
      reminders: decoded.reminders ?? [],
      externalId: decoded.external_id ?? null,
      externalEtag: decoded.external_etag ?? null,
      generator: decoded.generator ?? null,
      contentHash: decoded.content_hash ?? null,
      createdAt: decoded.created_at ?? null,
      updatedAt: decoded.updated_at ?? null,
      body: parsed.content,
      relPath: entry.rel,
      absPath: entry.abs,
    }
  })

const loadAll = (vaultDir: string): Effect.Effect<ReadonlyArray<CalendarEvent>, VaultError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => walkCalendar(vaultDir),
      catch: (e) =>
        new VaultError({
          message: `list calendar failed: ${String(e)}`,
          path: vaultDir,
          kind: "io_failure",
        }),
    })
    const out: Array<CalendarEvent> = []
    for (const entry of entries) {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(entry.abs, "utf8"),
        catch: (e) =>
          new VaultError({
            message: `read event failed: ${String(e)}`,
            path: entry.abs,
            kind: "io_failure",
          }),
      })
      out.push(yield* decodeEvent(entry, raw))
    }
    return out
  })

const atomicWrite = async (absPath: string, content: string): Promise<void> => {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  await mkdir(join(absPath, ".."), { recursive: true })
  await writeFile(tmp, content, "utf8")
  await rename(tmp, absPath)
}

const renderFrontmatter = (data: Record<string, unknown>, body: string): string =>
  matter.stringify(body, data)

export const FileSystemCalendarLive = (vaultDir: string) =>
  Layer.succeed(CalendarService, {
    list: (filter) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const matched = all.filter((e) => matchesFilter(e, filter))
        return sortByStart(matched)
      }),

    get: (slug) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        for (const e of all) if (e.slug === slug) return e
        return yield* Effect.fail(
          new VaultError({
            message: `event not found: ${slug}`,
            path: join(vaultDir, CALENDAR_DIR),
            kind: "not_found",
          }),
        )
      }),

    add: (input: EventAddInput) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const slug = input.slug ?? slugify(input.title)
        if (slug.length === 0) {
          return yield* Effect.fail(
            new VaultError({
              message: `cannot derive slug from title: ${input.title}`,
              path: join(vaultDir, CALENDAR_DIR),
              kind: "parse_failure",
            }),
          )
        }
        if (all.some((e) => e.slug === slug)) {
          return yield* Effect.fail(
            new VaultError({
              message: `event slug already exists: ${slug}`,
              path: join(vaultDir, CALENDAR_DIR),
              kind: "collision",
            }),
          )
        }

        const now = new Date().toISOString()
        const datePrefix = (() => {
          try {
            return datePart(input.startsAt)
          } catch {
            return null
          }
        })()
        if (!datePrefix) {
          return yield* Effect.fail(
            new VaultError({
              message: `invalid starts_at: ${input.startsAt}`,
              path: join(vaultDir, CALENDAR_DIR),
              kind: "parse_failure",
            }),
          )
        }
        const filename = `${datePrefix}--${slug}.md`
        const relPath = `${CALENDAR_DIR}/${filename}`
        const absPath = join(vaultDir, relPath)

        const body = (input.body ?? "").trimEnd()
        // Build frontmatter object excluding undefined fields so YAML stays clean.
        const fmInput: Record<string, unknown> = {
          slug,
          title: input.title,
          kind: input.kind,
          source: "user",
          starts_at: input.startsAt,
          tz: input.tz,
          status: input.status ?? "confirmed",
          all_day: input.allDay ?? false,
          created_at: now,
          updated_at: now,
          generator: GENERATOR,
        }
        if (input.endsAt) fmInput.ends_at = input.endsAt
        if (input.location) fmInput.location = input.location
        if (input.tickers && input.tickers.length > 0) fmInput.tickers = input.tickers
        if (input.topics && input.topics.length > 0) fmInput.topics = input.topics
        if (input.theses && input.theses.length > 0) fmInput.theses = input.theses
        if (input.tags && input.tags.length > 0) fmInput.tags = input.tags
        if (input.relatedPages && input.relatedPages.length > 0) {
          fmInput.related_pages = input.relatedPages
        }

        // Validate the frontmatter we're about to write — fail fast on bad enum values.
        yield* Schema.decodeUnknown(EventFrontmatter)(fmInput).pipe(
          Effect.mapError(
            (e) =>
              new VaultError({
                message: `event frontmatter invalid: ${String(e)}`,
                path: absPath,
                kind: "parse_failure",
              }),
          ),
        )

        // Render once without content_hash, hash, then re-render with the hash embedded.
        const draft = renderFrontmatter(fmInput, body)
        const contentHash = hashContent(draft)
        const finalFm = { ...fmInput, content_hash: contentHash }
        const final = renderFrontmatter(finalFm, body)

        yield* Effect.tryPromise({
          try: () => atomicWrite(absPath, final),
          catch: (e) =>
            new VaultError({
              message: `write event failed: ${String(e)}`,
              path: absPath,
              kind: "io_failure",
            }),
        })

        return { slug, absPath, relPath, contentHash }
      }),

    stamp: (slug, stamp: EventStamp) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const target = all.find((e) => e.slug === slug)
        if (!target) {
          return yield* Effect.fail(
            new VaultError({
              message: `event not found: ${slug}`,
              path: join(vaultDir, CALENDAR_DIR),
              kind: "not_found",
            }),
          )
        }
        const raw = yield* Effect.tryPromise({
          try: () => readFile(target.absPath, "utf8"),
          catch: (e) =>
            new VaultError({
              message: `read event failed: ${String(e)}`,
              path: target.absPath,
              kind: "io_failure",
            }),
        })
        const parsed = matter(raw)
        const data = { ...((parsed.data ?? {}) as Record<string, unknown>) }
        if (stamp.status !== undefined) data.status = stamp.status
        if (stamp.externalEtag !== undefined) data.external_etag = stamp.externalEtag
        if (stamp.contentHash !== undefined) data.content_hash = stamp.contentHash
        data.updated_at = stamp.updatedAt ?? new Date().toISOString()
        const rebuilt = renderFrontmatter(data, parsed.content)
        // Re-stat to make sure the file wasn't replaced under us mid-stamp.
        yield* Effect.tryPromise({
          try: () => stat(target.absPath),
          catch: (e) =>
            new VaultError({
              message: `stat failed: ${String(e)}`,
              path: target.absPath,
              kind: "io_failure",
            }),
        })
        yield* Effect.tryPromise({
          try: () => atomicWrite(target.absPath, rebuilt),
          catch: (e) =>
            new VaultError({
              message: `stamp event failed: ${String(e)}`,
              path: target.absPath,
              kind: "io_failure",
            }),
        })
      }),
  })

// Exported for tests.
export const _internal = { slugify, datePart, hashContent }
