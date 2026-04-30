import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { FileSystemCalendarLive } from "../adapters/FileSystemCalendar.js"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { LumaSuggesterLive } from "../adapters/LumaSuggester.js"
import { resolveVaultDir } from "../lib/env.js"
import { CalendarService, type CalendarEvent } from "../services/CalendarService.js"
import { EventSuggesterService } from "../services/EventSuggesterService.js"

const splitCsv = (s: string): ReadonlyArray<string> =>
  s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)

// --- pull ---

const cityOpt = Options.text("city").pipe(
  Options.withDescription("city slug (defaults to profile.identity.city)"),
  Options.optional,
)
const interestsOpt = Options.text("interests").pipe(
  Options.withDescription("comma-separated extra interests, e.g. 'ai,prediction-markets'"),
  Options.optional,
)
const limitOpt = Options.integer("limit").pipe(
  Options.withDescription("max candidates to score per source (default 100)"),
  Options.optional,
)
const minScoreOpt = Options.float("min-score").pipe(
  Options.withDescription("minimum match score 0..1 (overrides profile)"),
  Options.optional,
)

const pull = Command.make(
  "pull",
  { cityOpt, interestsOpt, limitOpt, minScoreOpt },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const sug = yield* EventSuggesterService
        const result = yield* sug.pull({
          city: Option.getOrUndefined(opts.cityOpt),
          interests: Option.getOrUndefined(Option.map(opts.interestsOpt, splitCsv)),
          limit: Option.getOrUndefined(opts.limitOpt),
          minMatchScore: Option.getOrUndefined(opts.minScoreOpt),
        })
        yield* Console.log(
          `fetched ${result.fetched}, matched ${result.matched}, wrote ${result.written.length} (skipped ${result.skippedDismissed} previously-dismissed)`,
        )
        for (const w of result.written) {
          const tag = w.upserted ? "upd" : "new"
          yield* Console.log(
            `  ${tag} ${w.startsAt.slice(0, 10)} ${w.score.toFixed(2)} ${w.title}  #${w.slug}`,
          )
        }
      })
      yield* program.pipe(
        Effect.provide(LumaSuggesterLive()),
        Effect.provide(FileSystemCalendarLive(vaultDir)),
        Effect.provide(FileSystemProfileLive(vaultDir)),
      )
    }),
).pipe(Command.withDescription("Pull events from configured sources and write topic-matched suggestions"))

// --- list ---

const formatSuggestionLine = (e: CalendarEvent): string => {
  const date = e.startsAt.slice(0, 10)
  const score = e.matchScore !== null ? e.matchScore.toFixed(2) : "----"
  const loc = e.location ? ` @ ${e.location.slice(0, 32)}` : ""
  return `${e.status.padEnd(9)} ${date} ${score} ${e.title}${loc}  #${e.slug}`
}

const statusFilterOpt = Options.text("status").pipe(
  Options.withDescription("comma-separated statuses (default: tentative). Pass 'all' to widen."),
  Options.optional,
)

const list = Command.make(
  "list",
  { statusFilterOpt },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const raw = Option.getOrUndefined(opts.statusFilterOpt)
      const statuses =
        !raw || raw === "tentative"
          ? (["tentative"] as const)
          : raw === "all"
            ? (["tentative", "confirmed", "cancelled"] as const)
            : (splitCsv(raw) as ReadonlyArray<"tentative" | "confirmed" | "cancelled">)
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const events = yield* cal.list({
          source: ["driver-events"],
          status: statuses,
        })
        if (events.length === 0) {
          yield* Console.log("(no event suggestions)")
          return
        }
        for (const e of events) yield* Console.log(formatSuggestionLine(e))
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("List event suggestions (default: tentative)"))

// --- show ---

const show = Command.make(
  "show",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const e = yield* cal.get(slug)
        const score = e.matchScore !== null ? e.matchScore.toFixed(2) : "n/a"
        yield* Console.log(`# ${e.title}`)
        yield* Console.log(
          `slug: ${e.slug}  status: ${e.status}  score: ${score}  source: ${e.source}`,
        )
        yield* Console.log(
          `starts_at: ${e.startsAt}${e.endsAt ? `  ends_at: ${e.endsAt}` : ""}  tz: ${e.tz}`,
        )
        if (e.location) yield* Console.log(`location: ${e.location}`)
        if (e.topics.length > 0) yield* Console.log(`topics: ${e.topics.join(", ")}`)
        if (e.tags.length > 0) yield* Console.log(`tags: ${e.tags.join(", ")}`)
        if (e.links.length > 0) {
          yield* Console.log("links:")
          for (const l of e.links) yield* Console.log(`  - ${l.title}: ${l.url}`)
        }
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("Show one event suggestion"))

// --- accept / dismiss ---

const accept = Command.make(
  "accept",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const r = yield* cal.accept(slug)
        const tag = r.noop ? "(already confirmed)" : "✓ accepted"
        yield* Console.log(`${tag} → ${r.relPath}`)
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("Promote a suggestion to a confirmed calendar event"))

const dismiss = Command.make(
  "dismiss",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const cal = yield* CalendarService
        const r = yield* cal.dismiss(slug)
        const tag = r.noop ? "(already dismissed)" : "✓ dismissed"
        yield* Console.log(`${tag} → ${r.relPath}`)
      })
      yield* program.pipe(Effect.provide(FileSystemCalendarLive(vaultDir)))
    }),
).pipe(Command.withDescription("Mark a suggestion cancelled (won't resurface on re-pulls)"))

export const events = Command.make("events").pipe(
  Command.withSubcommands([pull, list, show, accept, dismiss]),
  Command.withDescription("Discover and triage event suggestions (specs/events.md)"),
)
