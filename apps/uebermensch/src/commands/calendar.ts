import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { FileSystemCalendarLive } from "../adapters/FileSystemCalendar.js"
import { resolveVaultDir } from "../lib/env.js"
import { parseDateShortcut } from "../lib/calendar-filter.js"
import {
  CalendarService,
  type EventFilter,
  type EventAddInput,
} from "../services/CalendarService.js"
import type { CalendarEvent } from "../services/CalendarService.js"
import type { EventKind, EventSource, EventStatus } from "../schemas.js"

const KINDS: ReadonlyArray<EventKind> = [
  "personal",
  "deadline",
  "travel",
  "earnings",
  "macro",
  "regulatory",
  "corporate-action",
  "political",
  "prediction-market",
  "industry",
  "other",
]
const SOURCES: ReadonlyArray<EventSource> = [
  "user",
  "driver-markets",
  "driver-sec",
  "driver-gcal",
  "import",
]
const STATUSES: ReadonlyArray<EventStatus> = ["confirmed", "tentative", "cancelled"]

const splitCsv = (s: string): ReadonlyArray<string> =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

const validateEnum = <T extends string>(
  values: ReadonlyArray<string>,
  allowed: ReadonlyArray<T>,
  field: string,
): Effect.Effect<ReadonlyArray<T>, never> =>
  Effect.gen(function* () {
    const bad = values.filter((v) => !(allowed as ReadonlyArray<string>).includes(v))
    if (bad.length > 0) {
      yield* Console.error(
        `  ! invalid ${field}: ${bad.join(", ")} (allowed: ${allowed.join(", ")})`,
      )
    }
    return values.filter((v): v is T => (allowed as ReadonlyArray<string>).includes(v))
  })

// --- shared option helpers ---

const optList = (long: string, desc: string) =>
  Options.text(long).pipe(Options.withDescription(desc), Options.optional)

const sourceOpt = optList(
  "source",
  "comma-separated origins (user,driver-markets,driver-sec,driver-gcal,import)",
)
const kindOpt = optList(
  "kind",
  "comma-separated event kinds (personal,earnings,macro,deadline,…)",
)
const fromOpt = optList(
  "from",
  "lower bound (today, tomorrow, +Nd, +Nw, eom, or YYYY-MM-DD)",
)
const toOpt = optList("to", "upper bound (same shortcuts as --from)")
const tickersOpt = optList("tickers", "comma-separated tickers (e.g. NVDA,AMZN)")
const topicsOpt = optList("topics", "comma-separated topic slugs")
const thesesOpt = optList("theses", "comma-separated thesis slugs")
const tagOpt = optList("tag", "comma-separated tags")
const statusOpt = optList(
  "status",
  "comma-separated status (default: confirmed; pass tentative,confirmed to widen)",
)
const qOpt = Options.text("q").pipe(
  Options.withDescription("case-insensitive substring on title or body"),
  Options.optional,
)

const buildFilter = (
  source: Option.Option<string>,
  kind: Option.Option<string>,
  from: Option.Option<string>,
  to: Option.Option<string>,
  tickers: Option.Option<string>,
  topics: Option.Option<string>,
  theses: Option.Option<string>,
  tag: Option.Option<string>,
  status: Option.Option<string>,
  q: Option.Option<string>,
): Effect.Effect<EventFilter, never> =>
  Effect.gen(function* () {
    const now = new Date()
    const filter: {
      source?: ReadonlyArray<EventSource>
      kind?: ReadonlyArray<EventKind>
      from?: string
      to?: string
      tickers?: ReadonlyArray<string>
      topics?: ReadonlyArray<string>
      theses?: ReadonlyArray<string>
      tags?: ReadonlyArray<string>
      status: ReadonlyArray<EventStatus>
      q?: string
    } = { status: ["confirmed"] }

    const srcRaw = Option.getOrUndefined(source)
    if (srcRaw) {
      filter.source = yield* validateEnum<EventSource>(splitCsv(srcRaw), SOURCES, "source")
    }
    const kindRaw = Option.getOrUndefined(kind)
    if (kindRaw) {
      filter.kind = yield* validateEnum<EventKind>(splitCsv(kindRaw), KINDS, "kind")
    }
    const fromRaw = Option.getOrUndefined(from)
    if (fromRaw) {
      const d = parseDateShortcut(fromRaw, now, "from")
      if (d) filter.from = d.toISOString()
      else yield* Console.error(`  ! invalid --from: ${fromRaw}`)
    }
    const toRaw = Option.getOrUndefined(to)
    if (toRaw) {
      const d = parseDateShortcut(toRaw, now, "to")
      if (d) filter.to = d.toISOString()
      else yield* Console.error(`  ! invalid --to: ${toRaw}`)
    }
    const tickersRaw = Option.getOrUndefined(tickers)
    if (tickersRaw) filter.tickers = splitCsv(tickersRaw).map((t) => t.toUpperCase())
    const topicsRaw = Option.getOrUndefined(topics)
    if (topicsRaw) filter.topics = splitCsv(topicsRaw)
    const thesesRaw = Option.getOrUndefined(theses)
    if (thesesRaw) filter.theses = splitCsv(thesesRaw)
    const tagRaw = Option.getOrUndefined(tag)
    if (tagRaw) filter.tags = splitCsv(tagRaw)
    const statusRaw = Option.getOrUndefined(status)
    if (statusRaw) {
      filter.status = yield* validateEnum<EventStatus>(
        splitCsv(statusRaw),
        STATUSES,
        "status",
      )
    }
    const qRaw = Option.getOrUndefined(q)
    if (qRaw) filter.q = qRaw

    return filter
  })

// --- output rendering ---

const formatTime = (e: CalendarEvent): string => {
  if (e.allDay) return "all-day"
  // Render in event's tz when supported by the host runtime; fall back to ISO time.
  const d = new Date(e.startsAt)
  if (Number.isNaN(d.getTime())) return e.startsAt
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: e.tz,
    })
    return `${fmt.format(d)} ${e.tz}`
  } catch {
    return e.startsAt
  }
}

const formatLine = (e: CalendarEvent): string => {
  const date = e.startsAt.slice(0, 10)
  const time = formatTime(e)
  const tickers = e.tickers.length > 0 ? ` [${e.tickers.join(",")}]` : ""
  return `${e.status.padEnd(9)} ${date} ${time.padEnd(14)} ${e.kind.padEnd(17)} ${e.source.padEnd(15)} ${e.title}${tickers}  #${e.slug}`
}

// --- commands ---

const list = Command.make(
  "list",
  {
    sourceOpt,
    kindOpt,
    fromOpt,
    toOpt,
    tickersOpt,
    topicsOpt,
    thesesOpt,
    tagOpt,
    statusOpt,
    qOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const filter = yield* buildFilter(
        opts.sourceOpt,
        opts.kindOpt,
        opts.fromOpt,
        opts.toOpt,
        opts.tickersOpt,
        opts.topicsOpt,
        opts.thesesOpt,
        opts.tagOpt,
        opts.statusOpt,
        opts.qOpt,
      )
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const events = yield* cal.list(filter)
        if (events.length === 0) {
          yield* Console.log(`(no matching events in ${vaultDir}/calendar/)`)
          return
        }
        for (const e of events) yield* Console.log(formatLine(e))
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("List calendar events with optional filters"))

const show = Command.make(
  "show",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const e = yield* cal.get(slug)
        yield* Console.log(`# ${e.title}`)
        yield* Console.log(
          `slug: ${e.slug}  kind: ${e.kind}  source: ${e.source}  status: ${e.status}`,
        )
        yield* Console.log(
          `starts_at: ${e.startsAt}${e.endsAt ? `  ends_at: ${e.endsAt}` : ""}  tz: ${e.tz}${e.allDay ? "  (all-day)" : ""}`,
        )
        if (e.location) yield* Console.log(`location: ${e.location}`)
        if (e.tickers.length > 0) yield* Console.log(`tickers: ${e.tickers.join(", ")}`)
        if (e.topics.length > 0) yield* Console.log(`topics: ${e.topics.join(", ")}`)
        if (e.theses.length > 0) yield* Console.log(`theses: ${e.theses.join(", ")}`)
        if (e.tags.length > 0) yield* Console.log(`tags: ${e.tags.join(", ")}`)
        yield* Console.log("")
        yield* Console.log("--- body ---")
        yield* Console.log(e.body.trim().length > 0 ? e.body.trim() : "(empty)")
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("Show one event with frontmatter and body"))

// --- add ---

const titleOpt = Options.text("title").pipe(
  Options.withDescription("event title (required)"),
)
const startOpt = Options.text("start").pipe(
  Options.withDescription("ISO 8601 start (e.g. 2026-05-08T14:00:00+08:00 or 2026-05-08 with --all-day)"),
)
const endOpt = Options.text("end").pipe(
  Options.withDescription("ISO 8601 end (optional)"),
  Options.optional,
)
const tzOpt = Options.text("tz").pipe(
  Options.withDescription("IANA tz the event is anchored to (e.g. America/New_York)"),
)
const kindRequiredOpt = Options.choice("kind", [...KINDS]).pipe(
  Options.withDescription("event kind"),
)
const allDayOpt = Options.boolean("all-day").pipe(
  Options.withDescription("treat starts_at / ends_at as YYYY-MM-DD whole-day"),
  Options.withDefault(false),
)
const slugAddOpt = Options.text("slug").pipe(
  Options.withDescription("explicit slug (otherwise derived from title)"),
  Options.optional,
)
const locationOpt = Options.text("location").pipe(
  Options.withDescription("free-form location string"),
  Options.optional,
)
const addTickersOpt = Options.text("tickers").pipe(
  Options.withDescription("comma-separated tickers"),
  Options.optional,
)
const addTopicsOpt = Options.text("topics").pipe(
  Options.withDescription("comma-separated topic slugs"),
  Options.optional,
)
const addThesesOpt = Options.text("theses").pipe(
  Options.withDescription("comma-separated thesis slugs"),
  Options.optional,
)
const addTagsOpt = Options.text("tag").pipe(
  Options.withDescription("comma-separated tags"),
  Options.optional,
)
const bodyOpt = Options.text("body").pipe(
  Options.withDescription("free-form body markdown (notes, agenda)"),
  Options.optional,
)

const add = Command.make(
  "add",
  {
    titleOpt,
    startOpt,
    endOpt,
    tzOpt,
    kindRequiredOpt,
    allDayOpt,
    slugAddOpt,
    locationOpt,
    addTickersOpt,
    addTopicsOpt,
    addThesesOpt,
    addTagsOpt,
    bodyOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const tickers = Option.getOrUndefined(opts.addTickersOpt)
      const topics = Option.getOrUndefined(opts.addTopicsOpt)
      const theses = Option.getOrUndefined(opts.addThesesOpt)
      const tags = Option.getOrUndefined(opts.addTagsOpt)

      const input: EventAddInput = {
        title: opts.titleOpt,
        startsAt: opts.startOpt,
        tz: opts.tzOpt,
        kind: opts.kindRequiredOpt,
        allDay: opts.allDayOpt,
        endsAt: Option.getOrUndefined(opts.endOpt),
        location: Option.getOrUndefined(opts.locationOpt),
        slug: Option.getOrUndefined(opts.slugAddOpt),
        body: Option.getOrUndefined(opts.bodyOpt),
        tickers: tickers ? splitCsv(tickers).map((t) => t.toUpperCase()) : undefined,
        topics: topics ? splitCsv(topics) : undefined,
        theses: theses ? splitCsv(theses) : undefined,
        tags: tags ? splitCsv(tags) : undefined,
      }

      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const w = yield* cal.add(input)
        yield* Console.log(`✓ ${w.relPath} (${w.contentHash})`)
        yield* Console.log(`  slug: ${w.slug}`)
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("Add a personal (source: user) calendar event"))

export const calendar = Command.make("calendar").pipe(
  Command.withSubcommands([list, show, add]),
  Command.withDescription("Manage calendar events in $UBER_VAULT_DIR/calendar/"),
)
