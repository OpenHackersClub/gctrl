import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option, pipe } from "effect"
import { FileSystemCalendarLive } from "../adapters/FileSystemCalendar.js"
import { resolveVaultDir } from "../lib/env.js"
import { parseDateShortcut } from "../lib/calendar-filter.js"
import {
  CalendarService,
  type CalendarEvent,
  type EventAddInput,
  type EventFilter,
} from "../services/CalendarService.js"
import type { EventKind, EventSource, EventStatus } from "../schemas.js"

// --- enum allowlists (mirror the Schema literals; kept here so option help text
// can list them) ---

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

// --- small helpers (Option / CSV / enum validation) ---

const splitCsv = (s: string): ReadonlyArray<string> =>
  s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)

const csvOpt = (
  opt: Option.Option<string>,
): ReadonlyArray<string> | undefined =>
  pipe(opt, Option.map(splitCsv), Option.getOrUndefined)

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

// --- shared option declarations (reused across list + add) ---

const optList = (long: string, desc: string) =>
  Options.text(long).pipe(Options.withDescription(desc), Options.optional)

const sourceOpt = optList("source", `comma-separated origins (${SOURCES.join(",")})`)
const kindOpt = optList("kind", "comma-separated event kinds (personal,earnings,macro,…)")
const fromOpt = optList("from", "lower bound (today, tomorrow, +Nd, +Nw, eom, or YYYY-MM-DD)")
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

// --- buildFilter: turns CLI-Option inputs into an EventFilter ---

const resolveDate = (
  opt: Option.Option<string>,
  bound: "from" | "to",
  now: Date,
): Effect.Effect<string | undefined, never> =>
  Effect.gen(function* () {
    const raw = Option.getOrUndefined(opt)
    if (!raw) return undefined
    const d = parseDateShortcut(raw, now, bound)
    if (!d) {
      yield* Console.error(`  ! invalid --${bound}: ${raw}`)
      return undefined
    }
    return d.toISOString()
  })

const buildFilter = (opts: {
  sourceOpt: Option.Option<string>
  kindOpt: Option.Option<string>
  fromOpt: Option.Option<string>
  toOpt: Option.Option<string>
  tickersOpt: Option.Option<string>
  topicsOpt: Option.Option<string>
  thesesOpt: Option.Option<string>
  tagOpt: Option.Option<string>
  statusOpt: Option.Option<string>
  qOpt: Option.Option<string>
}): Effect.Effect<EventFilter, never> =>
  Effect.gen(function* () {
    const now = new Date()
    const sourceCsv = csvOpt(opts.sourceOpt)
    const kindCsv = csvOpt(opts.kindOpt)
    const statusCsv = csvOpt(opts.statusOpt)
    const tickers = csvOpt(opts.tickersOpt)?.map((t) => t.toUpperCase())
    return {
      status: statusCsv
        ? yield* validateEnum<EventStatus>(statusCsv, STATUSES, "status")
        : ["confirmed"],
      ...(sourceCsv && {
        source: yield* validateEnum<EventSource>(sourceCsv, SOURCES, "source"),
      }),
      ...(kindCsv && {
        kind: yield* validateEnum<EventKind>(kindCsv, KINDS, "kind"),
      }),
      ...(tickers && { tickers }),
      ...partial("topics", csvOpt(opts.topicsOpt)),
      ...partial("theses", csvOpt(opts.thesesOpt)),
      ...partial("tags", csvOpt(opts.tagOpt)),
      ...partial("from", yield* resolveDate(opts.fromOpt, "from", now)),
      ...partial("to", yield* resolveDate(opts.toOpt, "to", now)),
      ...partial("q", Option.getOrUndefined(opts.qOpt)),
    }
  })

// {key: value} when value is defined, else {} — for clean object spreads.
const partial = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))

// --- output rendering ---

const formatTime = (e: CalendarEvent): string => {
  if (e.allDay) return "all-day"
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
  const tickers = e.tickers.length > 0 ? ` [${e.tickers.join(",")}]` : ""
  return `${e.status.padEnd(9)} ${date} ${formatTime(e).padEnd(14)} ${e.kind.padEnd(17)} ${e.source.padEnd(15)} ${e.title}${tickers}  #${e.slug}`
}

// --- commands ---

const list = Command.make(
  "list",
  { sourceOpt, kindOpt, fromOpt, toOpt, tickersOpt, topicsOpt, thesesOpt, tagOpt, statusOpt, qOpt },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const filter = yield* buildFilter(opts)
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

// --- add — required + optional fields ---

const titleOpt = Options.text("title").pipe(Options.withDescription("event title (required)"))
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
    tickersOpt,
    topicsOpt,
    thesesOpt,
    tagOpt,
    bodyOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const tickers = csvOpt(opts.tickersOpt)?.map((t) => t.toUpperCase())
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
        tickers,
        topics: csvOpt(opts.topicsOpt),
        theses: csvOpt(opts.thesesOpt),
        tags: csvOpt(opts.tagOpt),
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
