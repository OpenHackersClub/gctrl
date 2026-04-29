import { Context, type Effect } from "effect"
import type { VaultError } from "../errors.js"
import type {
  Discipline,
  TimeboxNudge,
  TimeboxStatus,
} from "../schemas.js"

// === Domain shapes (camelCase projection of TimeboxFrontmatter) ===

export type Timebox = {
  readonly slug: string
  readonly title: string
  readonly discipline: Discipline
  readonly goal: string
  readonly deadline: string                  // ISO date or datetime
  readonly unit: string                      // pages | km | episodes | posts | ...
  readonly total: number
  readonly done: number                      // rolled up from completed children
  readonly sessionMinutes: number
  readonly sessionsPerWeek: number
  readonly status: TimeboxStatus
  readonly taperDaysBeforeDeadline: number | null
  readonly relatedPages: ReadonlyArray<string>
  readonly topics: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly nudges: ReadonlyArray<TimeboxNudge>
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly contentHash: string | null
  readonly body: string
  readonly relPath: string
  readonly absPath: string
}

// One proposed session in a planner dry-run; date is YYYY-MM-DD in profile tz.
export type PlannedSession = {
  readonly date: string
  readonly start: string                     // HH:MM, profile-local
  readonly end: string                       // HH:MM, profile-local
  readonly units: string                     // human-readable description (e.g. "12km easy")
}

// Proposal returned by `plan` / `replan` before `apply`.
export type TimeboxPlanProposal = {
  readonly timeboxSlug: string
  readonly sessionsNeeded: number
  readonly remainingUnits: number
  readonly unitsPerSession: number
  readonly sessions: ReadonlyArray<PlannedSession>
  readonly notes: ReadonlyArray<string>      // diagnostics (e.g. "skipped 2026-05-08 — already booked")
}

// === Inputs ===

export type TimeboxPlanInput = {
  readonly title: string
  readonly discipline: Discipline
  readonly goal?: string
  readonly total: number
  readonly unit: string
  readonly sessionMinutes: number
  readonly sessionsPerWeek: number
  readonly deadline: string                  // ISO 8601 date
  readonly tz: string                        // profile identity tz (used for child events)
  readonly taperDays?: number
  readonly relatedPages?: ReadonlyArray<string>
  readonly topics?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  readonly nudges?: ReadonlyArray<TimeboxNudge>
  readonly slug?: string                     // user override; otherwise derived from title
}

export type TimeboxAddEventInput = {
  readonly timeboxSlug: string
  readonly startsAt: string                  // ISO datetime
  readonly endsAt?: string
  readonly tz: string
  readonly units: string
  readonly status?: "confirmed" | "tentative"
}

// === Service ===

export interface TimeboxServiceShape {
  readonly list: (filter?: { status?: ReadonlyArray<TimeboxStatus>; discipline?: string })
    => Effect.Effect<ReadonlyArray<Timebox>, VaultError>

  readonly get: (slug: string) => Effect.Effect<Timebox, VaultError>

  // Plan + apply are split so callers can show a dry-run before committing.
  readonly plan: (input: TimeboxPlanInput) => Effect.Effect<TimeboxPlanProposal, VaultError>

  readonly apply: (input: TimeboxPlanInput, proposal: TimeboxPlanProposal)
    => Effect.Effect<{ timebox: Timebox; childSlugs: ReadonlyArray<string> }, VaultError>

  // Re-plan against remaining work + remaining time. User-edited child events
  // are pinned (kept in place); the planner redistributes the rest. Spec § Re-plan.
  readonly replan: (slug: string)
    => Effect.Effect<TimeboxPlanProposal, VaultError>

  readonly applyReplan: (slug: string, proposal: TimeboxPlanProposal)
    => Effect.Effect<{ timebox: Timebox; childSlugs: ReadonlyArray<string>; supersededSlugs: ReadonlyArray<string> }, VaultError>

  // Add a single child event outside the planner's automatic schedule.
  readonly addEvent: (input: TimeboxAddEventInput)
    => Effect.Effect<{ slug: string; step: number; stepTotal: number }, VaultError>

  // Mark a step done — flips the child event status to a terminal "done" form
  // (we encode as `status: confirmed` with metadata) and rolls `done` up on the parent.
  readonly complete: (slug: string, step: number)
    => Effect.Effect<Timebox, VaultError>

  // Mark a step skipped — does NOT increment `done`; child status becomes `cancelled`.
  readonly skip: (slug: string, step: number)
    => Effect.Effect<Timebox, VaultError>

  // Lifecycle: pause / resume / cancel / done.
  readonly setStatus: (slug: string, status: TimeboxStatus)
    => Effect.Effect<Timebox, VaultError>
}

export class TimeboxService extends Context.Tag("uebermensch/TimeboxService")<
  TimeboxService,
  TimeboxServiceShape
>() {}
