import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { FileSystemTimeboxLive } from "../adapters/FileSystemTimebox.js"
import { resolveVaultDir } from "../lib/env.js"
import {
  TimeboxService,
  type Timebox,
  type TimeboxPlanInput,
  type TimeboxPlanProposal,
} from "../services/TimeboxService.js"
import type { TimeboxStatus, TimeboxWorkingWindow } from "../schemas.js"

// === defaults ===
// In M0 we don't read profile.timeboxes yet — the CLI takes flags directly and
// falls back to a sensible weekday-mornings window. Wiring profile-driven
// defaults follows when M1 lands the planner --llm path.
const DEFAULT_WINDOWS: ReadonlyArray<TimeboxWorkingWindow> = [
  { days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "08:00" },
  { days: ["sat", "sun"], start: "08:00", end: "10:00" },
]

const STATUSES: ReadonlyArray<TimeboxStatus> = ["active", "paused", "done", "cancelled"]

// === shared options ===

const tzOpt = Options.text("tz").pipe(
  Options.withDescription("IANA tz for child events (e.g. Asia/Hong_Kong)"),
  Options.withDefault("UTC"),
)

// === list ===

const listStatusOpt = Options.choice("status", [...STATUSES]).pipe(
  Options.withDescription("filter by status"),
  Options.optional,
)
const listDisciplineOpt = Options.text("discipline").pipe(
  Options.withDescription("filter by discipline (reading, running, writing, …)"),
  Options.optional,
)

const formatTimeboxLine = (t: Timebox): string => {
  const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : 0
  const progress = `${t.done}/${t.total}${t.unit}`.padEnd(14)
  return `${t.status.padEnd(9)} ${t.discipline.padEnd(12)} ${progress} ${String(pct).padStart(3)}%  ${t.deadline.slice(0, 10)}  ${t.title}  #${t.slug}`
}

const list = Command.make(
  "list",
  { listStatusOpt, listDisciplineOpt },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const status = Option.getOrUndefined(opts.listStatusOpt)
        const discipline = Option.getOrUndefined(opts.listDisciplineOpt)
        const items = yield* svc.list({
          ...(status ? { status: [status] } : {}),
          ...(discipline ? { discipline } : {}),
        })
        if (items.length === 0) {
          yield* Console.log(`(no timeboxes in ${vaultDir}/action/events/timeboxes/)`)
          return
        }
        for (const t of items) yield* Console.log(formatTimeboxLine(t))
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("List timeboxes (optionally filtered by status / discipline)"))

// === show ===

const show = Command.make(
  "show",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const t = yield* svc.get(slug)
        const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : 0
        yield* Console.log(`# ${t.title}`)
        yield* Console.log(
          `slug: ${t.slug}  discipline: ${t.discipline}  status: ${t.status}`,
        )
        yield* Console.log(
          `progress: ${t.done}/${t.total} ${t.unit}  (${pct}%)  deadline: ${t.deadline.slice(0, 10)}`,
        )
        yield* Console.log(
          `cadence: ${t.sessionMinutes} min × ${t.sessionsPerWeek}/wk` +
            (t.taperDaysBeforeDeadline ? `  taper: ${t.taperDaysBeforeDeadline}d` : ""),
        )
        if (t.relatedPages.length > 0) {
          yield* Console.log(
            `related: ${t.relatedPages.map((p) => `[[${p}]]`).join("  ")}`,
          )
        }
        if (t.tags.length > 0) yield* Console.log(`tags: ${t.tags.join(", ")}`)
        yield* Console.log("")
        yield* Console.log("--- goal ---")
        yield* Console.log(t.goal)
        if (t.body.trim().length > 0) {
          yield* Console.log("")
          yield* Console.log("--- body ---")
          yield* Console.log(t.body.trim())
        }
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Show one timebox with progress + goal"))

// === plan / apply ===

const titleOpt = Options.text("title").pipe(Options.withDescription("plan title"))
const disciplineOpt = Options.text("discipline").pipe(
  Options.withDescription("discipline (reading, running, writing, …)"),
)
const goalOpt = Options.text("goal").pipe(
  Options.withDescription("plain-language goal (defaults to title)"),
  Options.optional,
)
const totalOpt = Options.float("total").pipe(
  Options.withDescription("total units to complete (e.g. 64)"),
)
const unitOpt = Options.text("unit").pipe(
  Options.withDescription("unit string (pages, km, episodes, posts, …)"),
)
const sessionMinutesOpt = Options.integer("session-minutes").pipe(
  Options.withDescription("typical session duration"),
  Options.withDefault(60),
)
const sessionsPerWeekOpt = Options.float("sessions-per-week").pipe(
  Options.withDescription("cadence hint"),
  Options.withDefault(3),
)
const deadlineOpt = Options.text("deadline").pipe(
  Options.withDescription("ISO 8601 date (e.g. 2026-09-27)"),
)
const taperDaysOpt = Options.integer("taper-days").pipe(
  Options.withDescription("leave the final N days clear of new sessions"),
  Options.optional,
)
const relatedPageOpt = Options.text("related-page").pipe(
  Options.withDescription("repeatable: bare slug for a wiki page (paper-constitutional-ai, running-log, …)"),
  Options.repeated,
)
const slugOverrideOpt = Options.text("slug").pipe(
  Options.withDescription("explicit timebox slug (otherwise derived from title)"),
  Options.optional,
)
const applyOpt = Options.boolean("apply").pipe(
  Options.withDescription("commit the plan (writes parent file + child events). Without --apply, prints a dry-run."),
  Options.withDefault(false),
)

const renderProposal = (p: TimeboxPlanProposal) =>
  Effect.gen(function* () {
    if (p.sessions.length === 0) {
      yield* Console.log(`(no sessions to schedule)`)
      for (const n of p.notes) yield* Console.log(`  · ${n}`)
      return
    }
    yield* Console.log(
      `proposed: ${p.sessions.length}/${p.sessionsNeeded} sessions  ~${p.unitsPerSession} units each  remaining: ${p.remainingUnits}`,
    )
    for (const s of p.sessions) {
      yield* Console.log(`  ${s.date}  ${s.start}-${s.end}  ${s.units}`)
    }
    if (p.notes.length > 0) {
      yield* Console.log(`notes:`)
      for (const n of p.notes) yield* Console.log(`  · ${n}`)
    }
  })

const plan = Command.make(
  "plan",
  {
    titleOpt,
    disciplineOpt,
    goalOpt,
    totalOpt,
    unitOpt,
    sessionMinutesOpt,
    sessionsPerWeekOpt,
    deadlineOpt,
    taperDaysOpt,
    tzOpt,
    relatedPageOpt,
    slugOverrideOpt,
    applyOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const input: TimeboxPlanInput = {
        title: opts.titleOpt,
        discipline: opts.disciplineOpt,
        goal: Option.getOrUndefined(opts.goalOpt),
        total: opts.totalOpt,
        unit: opts.unitOpt,
        sessionMinutes: opts.sessionMinutesOpt,
        sessionsPerWeek: opts.sessionsPerWeekOpt,
        deadline: opts.deadlineOpt,
        tz: opts.tzOpt,
        taperDays: Option.getOrUndefined(opts.taperDaysOpt),
        relatedPages: opts.relatedPageOpt as ReadonlyArray<string>,
        slug: Option.getOrUndefined(opts.slugOverrideOpt),
      }
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(input)
        yield* renderProposal(proposal)
        if (opts.applyOpt) {
          const { timebox, childSlugs } = yield* svc.apply(input, proposal)
          yield* Console.log("")
          yield* Console.log(`✓ wrote ${timebox.relPath}`)
          yield* Console.log(`✓ wrote ${childSlugs.length} child events`)
        } else {
          yield* Console.log("")
          yield* Console.log(`(dry-run — pass --apply to commit)`)
        }
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: opts.tzOpt,
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: opts.sessionMinutesOpt,
            defaultSessionsPerWeek: opts.sessionsPerWeekOpt,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Plan a new timebox; dry-run by default, --apply to commit"))

// === replan ===

const replan = Command.make(
  "replan",
  { slug: Args.text({ name: "slug" }), applyOpt },
  ({ slug, applyOpt }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.replan(slug)
        yield* renderProposal(proposal)
        if (applyOpt) {
          const result = yield* svc.applyReplan(slug, proposal)
          yield* Console.log("")
          yield* Console.log(`✓ wrote ${result.childSlugs.length} new child events`)
          if (result.supersededSlugs.length > 0) {
            yield* Console.log(`✓ superseded ${result.supersededSlugs.length} prior events`)
          }
        } else {
          yield* Console.log("")
          yield* Console.log(`(dry-run — pass --apply to commit)`)
        }
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Re-plan remaining sessions for a timebox"))

// === add-event ===

const addEventStartOpt = Options.text("start").pipe(
  Options.withDescription("ISO 8601 start (e.g. 2026-05-15T07:00:00+08:00)"),
)
const addEventEndOpt = Options.text("end").pipe(
  Options.withDescription("ISO 8601 end (optional)"),
  Options.optional,
)
const addEventUnitsOpt = Options.text("units").pipe(
  Options.withDescription("step description (e.g. \"12km easy\", \"pages 30-40\")"),
)

const addEvent = Command.make(
  "add-event",
  {
    slug: Args.text({ name: "slug" }),
    addEventStartOpt,
    addEventEndOpt,
    tzOpt,
    addEventUnitsOpt,
  },
  ({ slug, addEventStartOpt, addEventEndOpt, tzOpt, addEventUnitsOpt }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const result = yield* svc.addEvent({
          timeboxSlug: slug,
          startsAt: addEventStartOpt,
          endsAt: Option.getOrUndefined(addEventEndOpt),
          tz: tzOpt,
          units: addEventUnitsOpt,
        })
        yield* Console.log(`✓ session ${result.step}/${result.stepTotal}  #${result.slug}`)
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: tzOpt,
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Add a single session to an existing timebox"))

// === complete / skip ===

const stepArg = Args.integer({ name: "step" })

const complete = Command.make(
  "complete",
  { slug: Args.text({ name: "slug" }), step: stepArg },
  ({ slug, step }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        const t = yield* svc.complete(slug, step)
        const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : 0
        yield* Console.log(`✓ ${slug}:${step} complete — progress ${t.done}/${t.total} ${t.unit} (${pct}%)`)
        if (t.status === "done") yield* Console.log(`✓ timebox done`)
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Mark a step complete and roll progress up"))

const skip = Command.make(
  "skip",
  { slug: Args.text({ name: "slug" }), step: stepArg },
  ({ slug, step }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const svc = yield* TimeboxService
        yield* svc.skip(slug, step)
        yield* Console.log(`✓ ${slug}:${step} skipped`)
      })
      yield* program.pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: DEFAULT_WINDOWS,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 3,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Mark a step skipped (does not credit progress)"))

// === lifecycle ===

const lifecycleCommand = (name: TimeboxStatus, description: string) =>
  Command.make(
    name === "active" ? "resume" : name,
    { slug: Args.text({ name: "slug" }) },
    ({ slug }) =>
      Effect.gen(function* () {
        const vaultDir = yield* resolveVaultDir()
        const program = Effect.gen(function* () {
          const svc = yield* TimeboxService
          const t = yield* svc.setStatus(slug, name)
          yield* Console.log(`✓ ${t.slug} → ${t.status}`)
        })
        yield* program.pipe(
          Effect.provide(
            FileSystemTimeboxLive({
              vaultDir,
              tz: "UTC",
              workingWindows: DEFAULT_WINDOWS,
              defaultSessionMinutes: 60,
              defaultSessionsPerWeek: 3,
            }),
          ),
        )
      }),
  ).pipe(Command.withDescription(description))

const pause = lifecycleCommand("paused", "Pause an active timebox")
const resume = lifecycleCommand("active", "Resume a paused timebox")
const cancel = lifecycleCommand("cancelled", "Cancel a timebox")

export const timebox = Command.make("timebox").pipe(
  Command.withSubcommands([list, show, plan, replan, addEvent, complete, skip, pause, resume, cancel]),
  Command.withDescription("Manage timeboxes — multi-event practice plans under $UBER_VAULT_DIR/action/events/timeboxes/"),
)
