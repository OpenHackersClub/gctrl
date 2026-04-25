import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError, vaultIo } from "../errors.js"
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

const failVault = (
  message: string,
  path: string,
  kind: "not_found" | "collision" | "io_failure" | "parse_failure",
): Effect.Effect<never, VaultError> =>
  Effect.fail(new VaultError({ message, path, kind }))

type WalkEntry = { abs: string; rel: string }

const walkCalendar = async (root: string): Promise<ReadonlyArray<WalkEntry>> => {
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
    if (rel.split("/").includes(RECURRING_SUBDIR)) continue
    out.push({ abs, rel })
  }
  return out
}

// js-yaml auto-converts ISO 8601 strings to Date objects unless they're
// quoted in the source. Normalise back to ISO strings so the schema decodes
// hand-authored Obsidian files cleanly.
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

const decodeFrontmatter = (
  data: unknown,
  contextPath: string,
  contextLabel: string,
) =>
  Schema.decodeUnknown(EventFrontmatter)(data).pipe(
    Effect.mapError(
      (e) =>
        new VaultError({
          message: `${contextLabel} invalid frontmatter: ${String(e)}`,
          path: contextPath,
          kind: "parse_failure",
        }),
    ),
  )

const decodeEvent = (
  entry: WalkEntry,
  raw: string,
): Effect.Effect<CalendarEvent, VaultError> =>
  Effect.gen(function* () {
    const parsed = matter(raw)
    const data = normaliseDates((parsed.data ?? {}) as Record<string, unknown>)
    const decoded = yield* decodeFrontmatter(data, entry.abs, `event ${entry.rel}`)
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

const loadAll = (
  vaultDir: string,
): Effect.Effect<ReadonlyArray<CalendarEvent>, VaultError> =>
  Effect.gen(function* () {
    const entries = yield* vaultIo(() => walkCalendar(vaultDir), {
      message: "list calendar failed",
      path: vaultDir,
    })
    const out: Array<CalendarEvent> = []
    for (const entry of entries) {
      const raw = yield* vaultIo(() => readFile(entry.abs, "utf8"), {
        message: "read event failed",
        path: entry.abs,
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

// Drop empty arrays and nullish values so YAML stays clean.
const omitEmpty = (rec: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

export const FileSystemCalendarLive = (vaultDir: string) =>
  Layer.succeed(CalendarService, {
    list: (filter) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        return sortByStart(all.filter((e) => matchesFilter(e, filter)))
      }),

    get: (slug) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const found = all.find((e) => e.slug === slug)
        if (found) return found
        return yield* failVault(
          `event not found: ${slug}`,
          join(vaultDir, CALENDAR_DIR),
          "not_found",
        )
      }),

    add: (input: EventAddInput) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const calRoot = join(vaultDir, CALENDAR_DIR)
        const slug = input.slug ?? slugify(input.title)
        if (slug.length === 0) {
          return yield* failVault(
            `cannot derive slug from title: ${input.title}`,
            calRoot,
            "parse_failure",
          )
        }
        if (all.some((e) => e.slug === slug)) {
          return yield* failVault(
            `event slug already exists: ${slug}`,
            calRoot,
            "collision",
          )
        }

        let datePrefix: string
        try {
          datePrefix = datePart(input.startsAt)
        } catch {
          return yield* failVault(
            `invalid starts_at: ${input.startsAt}`,
            calRoot,
            "parse_failure",
          )
        }
        const relPath = `${CALENDAR_DIR}/${datePrefix}--${slug}.md`
        const absPath = join(vaultDir, relPath)
        const body = (input.body ?? "").trimEnd()
        const now = new Date().toISOString()

        const fmInput = omitEmpty({
          slug,
          title: input.title,
          kind: input.kind,
          source: "user",
          starts_at: input.startsAt,
          tz: input.tz,
          status: input.status ?? "confirmed",
          all_day: input.allDay ?? false,
          ends_at: input.endsAt,
          location: input.location,
          tickers: input.tickers,
          topics: input.topics,
          theses: input.theses,
          tags: input.tags,
          related_pages: input.relatedPages,
          created_at: now,
          updated_at: now,
          generator: GENERATOR,
        })

        // Validate before write — fail fast on bad enum values.
        yield* decodeFrontmatter(fmInput, absPath, "event")

        // Render once to compute the hash, then re-render with hash embedded.
        const draft = renderFrontmatter(fmInput, body)
        const contentHash = hashContent(draft)
        const final = renderFrontmatter({ ...fmInput, content_hash: contentHash }, body)

        yield* vaultIo(() => atomicWrite(absPath, final), {
          message: "write event failed",
          path: absPath,
        })

        return { slug, absPath, relPath, contentHash }
      }),

    stamp: (slug, stamp: EventStamp) =>
      Effect.gen(function* () {
        const all = yield* loadAll(vaultDir)
        const target = all.find((e) => e.slug === slug)
        if (!target) {
          return yield* failVault(
            `event not found: ${slug}`,
            join(vaultDir, CALENDAR_DIR),
            "not_found",
          )
        }
        const raw = yield* vaultIo(() => readFile(target.absPath, "utf8"), {
          message: "read event failed",
          path: target.absPath,
        })
        const parsed = matter(raw)
        const data = { ...((parsed.data ?? {}) as Record<string, unknown>) }
        if (stamp.status !== undefined) data.status = stamp.status
        if (stamp.externalEtag !== undefined) data.external_etag = stamp.externalEtag
        if (stamp.contentHash !== undefined) data.content_hash = stamp.contentHash
        data.updated_at = stamp.updatedAt ?? new Date().toISOString()
        const rebuilt = renderFrontmatter(data, parsed.content)
        // Re-stat to make sure the file wasn't replaced under us mid-stamp.
        yield* vaultIo(() => stat(target.absPath), {
          message: "stat failed",
          path: target.absPath,
        })
        yield* vaultIo(() => atomicWrite(target.absPath, rebuilt), {
          message: "stamp event failed",
          path: target.absPath,
        })
      }),
  })

export const _internal = { slugify, datePart, hashContent }
