// FileSystem-backed Timebox adapter.
// Spec: apps/uebermensch/vault/specs/calendar-timeboxes.md.
// Pattern mirrors FileSystemCalendar — vault is source of truth, no SQLite yet.

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import matter from "gray-matter"
import { VaultError, vaultIo } from "../errors.js"
import { plan as runPlanner, composeIsoInTz } from "../lib/timebox-planner.js"
import { ACTION_EVENTS_DIR } from "../lib/vault-paths.js"
import {
  EventFrontmatter,
  TimeboxFrontmatter,
  type TimeboxStatus,
  type TimeboxNudge,
  type TimeboxWorkingWindow,
} from "../schemas.js"
import {
  TimeboxService,
  type Timebox,
  type TimeboxAddEventInput,
  type TimeboxPlanInput,
  type TimeboxPlanProposal,
} from "../services/TimeboxService.js"
import type { CalendarEvent } from "../services/CalendarService.js"

const CALENDAR_DIR = ACTION_EVENTS_DIR
const TIMEBOXES_SUBDIR = "timeboxes"
const RECURRING_SUBDIR = "recurring"
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

const failVault = (
  message: string,
  path: string,
  kind: "not_found" | "collision" | "io_failure" | "parse_failure",
): Effect.Effect<never, VaultError> =>
  Effect.fail(new VaultError({ message, path, kind }))

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

const omitEmpty = (rec: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

const atomicWrite = async (absPath: string, content: string): Promise<void> => {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  await mkdir(join(absPath, ".."), { recursive: true })
  await writeFile(tmp, content, "utf8")
  await rename(tmp, absPath)
}

const renderFrontmatter = (data: Record<string, unknown>, body: string): string =>
  matter.stringify(body, data)

// --- timebox parent file walking ---

type WalkEntry = { abs: string; rel: string }

const walkTimeboxes = async (vaultDir: string): Promise<ReadonlyArray<WalkEntry>> => {
  const root = join(vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR)
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  const out: Array<WalkEntry> = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (extname(e.name).toLowerCase() !== ".md") continue
    const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? root
    const abs = join(parent, e.name)
    out.push({ abs, rel: relative(vaultDir, abs) })
  }
  return out
}

// Walk all calendar events (excluding recurring/) so we can find children of a
// timebox + check for double-bookings during planning. Mirrors FileSystemCalendar.
const walkCalendarEvents = async (vaultDir: string): Promise<ReadonlyArray<WalkEntry>> => {
  const root = join(vaultDir, CALENDAR_DIR)
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  const out: Array<WalkEntry> = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (extname(e.name).toLowerCase() !== ".md") continue
    const parent = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? root
    const abs = join(parent, e.name)
    const rel = relative(vaultDir, abs)
    const segments = rel.split("/")
    if (segments.includes(RECURRING_SUBDIR)) continue
    if (segments.includes(TIMEBOXES_SUBDIR)) continue
    out.push({ abs, rel })
  }
  return out
}

const decodeTimebox = (
  entry: WalkEntry,
  raw: string,
): Effect.Effect<Timebox, VaultError> =>
  Effect.gen(function* () {
    const parsed = matter(raw)
    const data = normaliseDates((parsed.data ?? {}) as Record<string, unknown>)
    const decoded = yield* Schema.decodeUnknown(TimeboxFrontmatter)(data).pipe(
      Effect.mapError(
        (e) =>
          new VaultError({
            message: `timebox ${entry.rel} invalid frontmatter: ${String(e)}`,
            path: entry.abs,
            kind: "parse_failure",
          }),
      ),
    )
    const nudgesArr = decoded.coaching?.nudges ?? []
    return {
      slug: decoded.slug,
      title: decoded.title,
      discipline: decoded.discipline,
      goal: decoded.goal,
      deadline: decoded.deadline,
      unit: decoded.unit,
      total: decoded.total,
      done: decoded.done ?? 0,
      sessionMinutes: decoded.session_minutes,
      sessionsPerWeek: decoded.sessions_per_week,
      status: decoded.status,
      taperDaysBeforeDeadline: decoded.taper_days_before_deadline ?? null,
      relatedPages: decoded.related_pages ?? [],
      topics: decoded.topics ?? [],
      tags: decoded.tags ?? [],
      nudges: nudgesArr as ReadonlyArray<TimeboxNudge>,
      createdAt: decoded.created_at ?? null,
      updatedAt: decoded.updated_at ?? null,
      contentHash: decoded.content_hash ?? null,
      body: parsed.content,
      relPath: entry.rel,
      absPath: entry.abs,
    }
  })

const decodeEvent = (
  entry: WalkEntry,
  raw: string,
): Effect.Effect<CalendarEvent, VaultError> =>
  Effect.gen(function* () {
    const parsed = matter(raw)
    const data = normaliseDates((parsed.data ?? {}) as Record<string, unknown>)
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
      matchScore: decoded.match_score ?? null,
      matchedTerms: decoded.matched_terms ?? [],
      body: parsed.content,
      relPath: entry.rel,
      absPath: entry.abs,
    }
  })

const loadTimeboxes = (vaultDir: string): Effect.Effect<ReadonlyArray<Timebox>, VaultError> =>
  Effect.gen(function* () {
    const entries = yield* vaultIo(() => walkTimeboxes(vaultDir), {
      message: "list timeboxes failed",
      path: vaultDir,
    })
    const out: Array<Timebox> = []
    for (const entry of entries) {
      const raw = yield* vaultIo(() => readFile(entry.abs, "utf8"), {
        message: "read timebox failed",
        path: entry.abs,
      })
      out.push(yield* decodeTimebox(entry, raw))
    }
    return out
  })

const loadEvents = (vaultDir: string): Effect.Effect<ReadonlyArray<CalendarEvent>, VaultError> =>
  Effect.gen(function* () {
    const entries = yield* vaultIo(() => walkCalendarEvents(vaultDir), {
      message: "list events failed",
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

// --- write helpers ---

const writeTimeboxFile = (vaultDir: string, slug: string, fmInput: Record<string, unknown>, body: string) =>
  Effect.gen(function* () {
    const relPath = `${CALENDAR_DIR}/${TIMEBOXES_SUBDIR}/${slug}.md`
    const absPath = join(vaultDir, relPath)
    const draft = renderFrontmatter(fmInput, body)
    const contentHash = hashContent(draft)
    const final = renderFrontmatter({ ...fmInput, content_hash: contentHash }, body)
    yield* vaultIo(() => atomicWrite(absPath, final), {
      message: "write timebox failed",
      path: absPath,
    })
    return { absPath, relPath, contentHash }
  })

const writeChildEventFile = (
  vaultDir: string,
  date: string,
  parentSlug: string,
  ordinal: number,
  fmInput: Record<string, unknown>,
  body: string,
) =>
  Effect.gen(function* () {
    // Suffix sessions same-day: -a, -b, -c... (most plans don't pack same-day,
    // so the bare form is the common case.)
    const suffix = ordinal > 0 ? `-${String.fromCharCode("a".charCodeAt(0) + ordinal)}` : ""
    const childSlug = `${date}--${parentSlug}${suffix}`
    const relPath = `${CALENDAR_DIR}/${childSlug}.md`
    const absPath = join(vaultDir, relPath)
    const draft = renderFrontmatter({ ...fmInput, slug: childSlug }, body)
    const contentHash = hashContent(draft)
    const final = renderFrontmatter({ ...fmInput, slug: childSlug, content_hash: contentHash }, body)
    yield* vaultIo(() => atomicWrite(absPath, final), {
      message: "write child event failed",
      path: absPath,
    })
    return { childSlug, absPath, relPath }
  })

// --- service config ---

export type FileSystemTimeboxConfig = {
  readonly vaultDir: string
  readonly tz: string                                // profile identity tz; used for child events
  readonly workingWindows: ReadonlyArray<TimeboxWorkingWindow>
  readonly defaultSessionMinutes: number
  readonly defaultSessionsPerWeek: number
  readonly now?: () => Date                          // injectable for tests
}

const fallbackWindows: ReadonlyArray<TimeboxWorkingWindow> = [
  { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "10:00" },
  { days: ["sat", "sun"], start: "09:00", end: "11:00" },
]

export const FileSystemTimeboxLive = (config: FileSystemTimeboxConfig) => {
  const now = config.now ?? (() => new Date())
  const workingWindows =
    config.workingWindows.length > 0 ? config.workingWindows : fallbackWindows

  // Scan all calendar events and return raw frontmatter records keyed by slug
  // for any event whose `timebox` field matches. We do this by reading the
  // YAML directly so we get `step`/`step_total` without widening CalendarEvent.
  const scanChildren = (vaultDir: string, parentSlug: string) =>
    Effect.gen(function* () {
      const entries = yield* vaultIo(() => walkCalendarEvents(vaultDir), {
        message: "list events failed",
        path: vaultDir,
      })
      type Child = {
        rel: string
        abs: string
        raw: string
        data: Record<string, unknown>
        body: string
        step: number
        stepTotal: number
        status: string
      }
      const out: Array<Child> = []
      for (const entry of entries) {
        const raw = yield* vaultIo(() => readFile(entry.abs, "utf8"), {
          message: "read event failed",
          path: entry.abs,
        })
        const parsed = matter(raw)
        const data = normaliseDates((parsed.data ?? {}) as Record<string, unknown>) as Record<string, unknown>
        if (data.timebox !== parentSlug) continue
        const step = Number(data.step ?? 0)
        const stepTotal = Number(data.step_total ?? 0)
        const status = String(data.status ?? "confirmed")
        out.push({
          rel: entry.rel,
          abs: entry.abs,
          raw,
          data,
          body: parsed.content,
          step,
          stepTotal,
          status,
        })
      }
      out.sort((a, b) => a.step - b.step)
      return out
    })

  const writeProposalAsChildren = (
    vaultDir: string,
    parentSlug: string,
    parentTitle: string,
    proposal: TimeboxPlanProposal,
    tz: string,
    sessionMinutes: number,
  ) =>
    Effect.gen(function* () {
      const childSlugs: Array<string> = []
      const stepTotal = proposal.sessions.length
      // Group by date so we can suffix collisions if a plan stacks multiple per day.
      const sameDayCounter = new Map<string, number>()
      for (let i = 0; i < proposal.sessions.length; i++) {
        const s = proposal.sessions[i]
        const ordinal = sameDayCounter.get(s.date) ?? 0
        sameDayCounter.set(s.date, ordinal + 1)

        const startsAt = composeIsoInTz(s.date, s.start, tz)
        const endsAt = composeIsoInTz(s.date, s.end, tz)
        const step = i + 1

        const fm = omitEmpty({
          title: `${parentTitle} · ${s.units} · session ${step}/${stepTotal}`,
          kind: "practice",
          source: "user",
          starts_at: startsAt,
          ends_at: endsAt,
          tz,
          status: "confirmed",
          all_day: false,
          generator: GENERATOR,
          created_at: now().toISOString(),
          updated_at: now().toISOString(),
          timebox: parentSlug,
          step,
          step_total: stepTotal,
          step_units: s.units,
        })

        // Validate child shape before write
        yield* Schema.decodeUnknown(EventFrontmatter)({ ...fm, slug: `${s.date}--${parentSlug}` }).pipe(
          Effect.mapError(
            (e) =>
              new VaultError({
                message: `child event invalid frontmatter: ${String(e)}`,
                path: vaultDir,
                kind: "parse_failure",
              }),
          ),
        )

        const written = yield* writeChildEventFile(vaultDir, s.date, parentSlug, ordinal, fm, "")
        childSlugs.push(written.childSlug)
      }
      return childSlugs
    })

  const stampParentDone = (
    vaultDir: string,
    timebox: Timebox,
    newDone: number,
    newStatus?: TimeboxStatus,
  ) =>
    Effect.gen(function* () {
      const raw = yield* vaultIo(() => readFile(timebox.absPath, "utf8"), {
        message: "read timebox failed",
        path: timebox.absPath,
      })
      const parsed = matter(raw)
      const data = { ...((parsed.data ?? {}) as Record<string, unknown>) }
      data.done = newDone
      if (newStatus) data.status = newStatus
      data.updated_at = now().toISOString()
      // Recompute hash
      const draft = renderFrontmatter(data, parsed.content)
      const newHash = hashContent(draft)
      data.content_hash = newHash
      const final = renderFrontmatter(data, parsed.content)
      yield* vaultIo(() => atomicWrite(timebox.absPath, final), {
        message: "stamp timebox failed",
        path: timebox.absPath,
      })
    })

  const stampChildStatus = (abs: string, body: string, data: Record<string, unknown>, status: string) =>
    Effect.gen(function* () {
      const next = { ...data, status, updated_at: now().toISOString() }
      const draft = renderFrontmatter(next, body)
      const hash = hashContent(draft)
      const final = renderFrontmatter({ ...next, content_hash: hash }, body)
      yield* vaultIo(() => atomicWrite(abs, final), {
        message: "stamp child failed",
        path: abs,
      })
    })

  return Layer.succeed(TimeboxService, {
    list: (filter) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        return all.filter((t) => {
          if (filter?.status && filter.status.length > 0 && !filter.status.includes(t.status)) return false
          if (filter?.discipline && t.discipline !== filter.discipline) return false
          return true
        })
      }),

    get: (slug) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const found = all.find((t) => t.slug === slug)
        if (found) return found
        return yield* failVault(
          `timebox not found: ${slug}`,
          join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
          "not_found",
        )
      }),

    plan: (input: TimeboxPlanInput) =>
      Effect.gen(function* () {
        const slug = input.slug ?? slugify(input.title)
        if (slug.length === 0) {
          return yield* failVault(
            `cannot derive slug from title: ${input.title}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "parse_failure",
          )
        }
        const events = yield* loadEvents(config.vaultDir)
        const proposal = runPlanner({
          slug,
          remainingUnits: input.total,                      // brand-new plan: done == 0
          unit: input.unit,
          sessionMinutes: input.sessionMinutes,
          sessionsPerWeek: input.sessionsPerWeek,
          deadline: input.deadline,
          taperDays: input.taperDays ?? 0,
          today: now(),
          workingWindows,
          existingEvents: events,
        })
        return proposal
      }),

    apply: (input: TimeboxPlanInput, proposal: TimeboxPlanProposal) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const slug = input.slug ?? slugify(input.title)
        if (all.some((t) => t.slug === slug)) {
          return yield* failVault(
            `timebox slug already exists: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "collision",
          )
        }
        const nowIso = now().toISOString()
        const fm = omitEmpty({
          slug,
          kind: "practice",
          discipline: input.discipline,
          title: input.title,
          goal: input.goal ?? input.title,
          deadline: input.deadline,
          unit: input.unit,
          total: input.total,
          done: 0,
          session_minutes: input.sessionMinutes,
          sessions_per_week: input.sessionsPerWeek,
          status: "active",
          taper_days_before_deadline: input.taperDays,
          related_pages: input.relatedPages,
          topics: input.topics,
          tags: input.tags,
          coaching: input.nudges && input.nudges.length > 0 ? { nudges: input.nudges } : undefined,
          created_at: nowIso,
          updated_at: nowIso,
        })
        // Validate before write
        yield* Schema.decodeUnknown(TimeboxFrontmatter)(fm).pipe(
          Effect.mapError(
            (e) =>
              new VaultError({
                message: `timebox invalid frontmatter: ${String(e)}`,
                path: join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
                kind: "parse_failure",
              }),
          ),
        )
        const body = `## Goal\n\n${input.goal ?? input.title}\n`
        yield* writeTimeboxFile(config.vaultDir, slug, fm, body)

        const childSlugs = yield* writeProposalAsChildren(
          config.vaultDir,
          slug,
          input.title,
          proposal,
          input.tz,
          input.sessionMinutes,
        )

        // Re-read parent
        const reloaded = yield* loadTimeboxes(config.vaultDir)
        const tb = reloaded.find((t) => t.slug === slug)
        if (!tb) {
          return yield* failVault(
            `timebox written but not loadable: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "io_failure",
          )
        }
        return { timebox: tb, childSlugs }
      }),

    replan: (slug: string) =>
      Effect.gen(function* () {
        const tb = yield* loadTimeboxes(config.vaultDir).pipe(
          Effect.flatMap((all) => {
            const t = all.find((x) => x.slug === slug)
            if (!t) {
              return failVault(
                `timebox not found: ${slug}`,
                join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
                "not_found",
              )
            }
            return Effect.succeed(t)
          }),
        )
        const events = yield* loadEvents(config.vaultDir)
        // Existing events for double-booking exclude this timebox's own pending children
        const otherEvents = events.filter((e) => {
          // We can't see `timebox:` in CalendarEvent type, so re-read on the fly
          // would be expensive; for M0 we accept that re-plan won't double-book
          // against own pending children (those are about to be superseded).
          return true
        })
        const remainingUnits = Math.max(0, tb.total - tb.done)
        const proposal = runPlanner({
          slug: tb.slug,
          remainingUnits,
          unit: tb.unit,
          sessionMinutes: tb.sessionMinutes,
          sessionsPerWeek: tb.sessionsPerWeek,
          deadline: tb.deadline,
          taperDays: tb.taperDaysBeforeDeadline ?? 0,
          today: now(),
          workingWindows,
          existingEvents: otherEvents,
        })
        return proposal
      }),

    applyReplan: (slug: string, proposal: TimeboxPlanProposal) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const tb = all.find((t) => t.slug === slug)
        if (!tb) {
          return yield* failVault(
            `timebox not found: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "not_found",
          )
        }
        // Mark all non-done, non-cancelled children as superseded.
        // M0 policy: pin user-edited children where `updated_at > created_at + 60s`.
        const children = yield* scanChildren(config.vaultDir, slug)
        const supersededSlugs: Array<string> = []
        for (const c of children) {
          if (c.status === "cancelled" || c.status === "superseded") continue
          // Treat anything with `updated_at` clearly later than `created_at` as user-edited
          const created = c.data.created_at ? Date.parse(String(c.data.created_at)) : 0
          const updated = c.data.updated_at ? Date.parse(String(c.data.updated_at)) : 0
          const isPinned = updated > 0 && created > 0 && updated - created > 60_000
          if (isPinned) continue
          // Don't supersede ones already complete
          if (c.data.step_units && c.data.step && c.status === "confirmed" && c.data.completed_at) continue
          yield* stampChildStatus(c.abs, c.body, c.data, "superseded")
          supersededSlugs.push(String(c.data.slug ?? c.rel))
        }

        const childSlugs = yield* writeProposalAsChildren(
          config.vaultDir,
          slug,
          tb.title,
          proposal,
          // re-use the tz of the first existing child if any, else fallback to UTC
          children[0] ? String(children[0].data.tz ?? "UTC") : "UTC",
          tb.sessionMinutes,
        )
        const reloaded = yield* loadTimeboxes(config.vaultDir)
        const tb2 = reloaded.find((t) => t.slug === slug)
        if (!tb2) {
          return yield* failVault(
            `timebox vanished after replan: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "io_failure",
          )
        }
        return { timebox: tb2, childSlugs, supersededSlugs }
      }),

    addEvent: (input: TimeboxAddEventInput) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const tb = all.find((t) => t.slug === input.timeboxSlug)
        if (!tb) {
          return yield* failVault(
            `timebox not found: ${input.timeboxSlug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "not_found",
          )
        }
        const children = yield* scanChildren(config.vaultDir, input.timeboxSlug)
        const activeChildren = children.filter((c) => c.status !== "cancelled" && c.status !== "superseded")
        const stepTotal = activeChildren.length + 1
        const step = stepTotal
        const dateMatch = input.startsAt.match(/^(\d{4}-\d{2}-\d{2})/)
        if (!dateMatch) {
          return yield* failVault(
            `invalid starts_at: ${input.startsAt}`,
            join(config.vaultDir, CALENDAR_DIR),
            "parse_failure",
          )
        }
        const date = dateMatch[1]
        const ordinal = activeChildren.filter(
          (c) => String(c.data.starts_at ?? "").startsWith(date),
        ).length
        const fm = omitEmpty({
          title: `${tb.title} · ${input.units} · session ${step}/${stepTotal}`,
          kind: "practice",
          source: "user",
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          tz: input.tz,
          status: input.status ?? "confirmed",
          all_day: false,
          generator: GENERATOR,
          created_at: now().toISOString(),
          updated_at: now().toISOString(),
          timebox: input.timeboxSlug,
          step,
          step_total: stepTotal,
          step_units: input.units,
        })
        const written = yield* writeChildEventFile(
          config.vaultDir,
          date,
          input.timeboxSlug,
          ordinal,
          fm,
          "",
        )
        return { slug: written.childSlug, step, stepTotal }
      }),

    complete: (slug: string, step: number) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const tb = all.find((t) => t.slug === slug)
        if (!tb) {
          return yield* failVault(
            `timebox not found: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "not_found",
          )
        }
        const children = yield* scanChildren(config.vaultDir, slug)
        const target = children.find((c) => c.step === step)
        if (!target) {
          return yield* failVault(
            `step not found: ${slug}:${step}`,
            join(config.vaultDir, CALENDAR_DIR),
            "not_found",
          )
        }
        if (target.data.completed_at) {
          // Idempotent — already complete.
          return tb
        }
        // Parse units from step_units to credit `done`. For ranges (`pages 30-40`)
        // we credit (end - start + 1); for "12km" we extract the leading number;
        // for "1 episode"/"3 sessions" we credit the leading number; otherwise 0.
        const units = String(target.data.step_units ?? "")
        const credit = parseUnitsCredit(units, tb.unit, tb.total / Math.max(1, target.stepTotal))
        const newDone = Math.min(tb.total, tb.done + credit)

        // Stamp child as completed (still status: confirmed but with completed_at)
        const childData = { ...target.data, completed_at: now().toISOString() }
        yield* stampChildStatus(target.abs, target.body, childData, "confirmed")

        const newStatus: TimeboxStatus | undefined = newDone >= tb.total ? "done" : undefined
        yield* stampParentDone(config.vaultDir, tb, newDone, newStatus)
        const reloaded = yield* loadTimeboxes(config.vaultDir)
        return reloaded.find((t) => t.slug === slug)!
      }),

    skip: (slug: string, step: number) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const tb = all.find((t) => t.slug === slug)
        if (!tb) {
          return yield* failVault(
            `timebox not found: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "not_found",
          )
        }
        const children = yield* scanChildren(config.vaultDir, slug)
        const target = children.find((c) => c.step === step)
        if (!target) {
          return yield* failVault(
            `step not found: ${slug}:${step}`,
            join(config.vaultDir, CALENDAR_DIR),
            "not_found",
          )
        }
        yield* stampChildStatus(target.abs, target.body, target.data, "cancelled")
        return tb
      }),

    setStatus: (slug: string, status: TimeboxStatus) =>
      Effect.gen(function* () {
        const all = yield* loadTimeboxes(config.vaultDir)
        const tb = all.find((t) => t.slug === slug)
        if (!tb) {
          return yield* failVault(
            `timebox not found: ${slug}`,
            join(config.vaultDir, CALENDAR_DIR, TIMEBOXES_SUBDIR),
            "not_found",
          )
        }
        yield* stampParentDone(config.vaultDir, tb, tb.done, status)
        const reloaded = yield* loadTimeboxes(config.vaultDir)
        return reloaded.find((t) => t.slug === slug)!
      }),
  })
}

// Extract a numeric credit from a `step_units` string. Conventions:
//  - `pages 30-40` → 11 (40 - 30 + 1)
//  - `12km` / `12 km` → 12
//  - `1 episode` / `3 sessions` → leading number
//  - falls back to evenSlice when nothing parses (so `complete` always credits something)
const parseUnitsCredit = (units: string, _unit: string, evenSlice: number): number => {
  const range = units.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return Math.max(0, b - a + 1)
  }
  const lead = units.match(/^(\d+(?:\.\d+)?)/)
  if (lead) return Number(lead[1])
  return Math.max(0.001, evenSlice)
}

export const _internal = { slugify, hashContent, parseUnitsCredit }
