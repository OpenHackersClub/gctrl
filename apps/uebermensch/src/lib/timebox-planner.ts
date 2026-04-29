// Pure deterministic planner for timeboxes.
// Spec: apps/uebermensch/vault/specs/calendar-timeboxes.md § Planner.
//
// Inputs: timebox (or planning input) + working_windows + existing events to avoid.
// Output: proposal with N sessions placed in working windows, ending by deadline
// (minus optional taper). No I/O, no LLM — that's the M1 extension.

import type { CalendarEvent } from "../services/CalendarService.js"
import type {
  PlannedSession,
  TimeboxPlanProposal,
} from "../services/TimeboxService.js"
import type { TimeboxWorkingWindow } from "../schemas.js"

const DAY_MS = 86_400_000
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
type Weekday = (typeof WEEKDAY_NAMES)[number]

export type PlannerInputs = {
  readonly slug: string
  readonly remainingUnits: number
  readonly unit: string
  readonly sessionMinutes: number
  readonly sessionsPerWeek: number
  readonly deadline: string                // ISO date or datetime
  readonly taperDays: number
  readonly today: Date                     // injectable for tests
  readonly workingWindows: ReadonlyArray<TimeboxWorkingWindow>
  readonly existingEvents: ReadonlyArray<CalendarEvent>
}

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

const parseHM = (hm: string): { h: number; m: number } => {
  const [h, m] = hm.split(":").map((s) => Number.parseInt(s, 10))
  return { h, m }
}

const fmtHM = (h: number, m: number): string =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`

const isoDate = (d: Date): string => {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const weekdayOf = (d: Date): Weekday => WEEKDAY_NAMES[d.getUTCDay()]

// Round units to a reasonable precision (1 decimal for fractional units like km;
// integer for naturally-discrete units like pages — but we keep 1dp to be safe).
const roundUnits = (n: number): number => Math.round(n * 10) / 10

// "12km easy" / "pages 30-40" / "1 episode" — single-unit-per-session description.
// Range form for monotonic countable units (pages, chapters); duration form otherwise.
const formatUnits = (
  unit: string,
  unitsThisSession: number,
  cumulativeBefore: number,
  isLastSession: boolean,
  totalRemaining: number,
): string => {
  // Final session absorbs rounding remainder
  const u = isLastSession ? roundUnits(totalRemaining - cumulativeBefore) : roundUnits(unitsThisSession)
  if (unit === "pages" || unit === "chapters") {
    const start = Math.floor(cumulativeBefore) + 1
    const end = Math.floor(cumulativeBefore + u)
    if (start >= end) return `${unit.slice(0, -1)} ${start}`
    return `${unit} ${start}–${end}`
  }
  if (unit === "km" || unit === "miles") {
    return `${u}${unit}`
  }
  if (unit === "episodes" || unit === "posts" || unit === "sessions") {
    return `${u} ${u === 1 ? unit.slice(0, -1) : unit}`
  }
  return `${u} ${unit}`
}

const overlapsExistingEvent = (
  startMs: number,
  endMs: number,
  existing: ReadonlyArray<CalendarEvent>,
): boolean => {
  for (const e of existing) {
    if (e.status === "cancelled" || e.status === "superseded") continue
    const eStart = Date.parse(e.startsAt)
    if (Number.isNaN(eStart)) continue
    const eEnd = e.endsAt ? Date.parse(e.endsAt) : eStart + 30 * 60_000
    if (startMs < eEnd && endMs > eStart) return true
  }
  return false
}

// Walk forward from `today + 1d` placing sessions one at a time. For each day:
//  1. Check the day falls within a working_windows entry (matched by weekday).
//  2. For each matching window, attempt to allocate a slot of `sessionMinutes`.
//  3. Skip if the slot overlaps an existing confirmed/tentative event.
//  4. Stop when sessionsNeeded met or deadline (minus taper) reached.
export const plan = (inputs: PlannerInputs): TimeboxPlanProposal => {
  const notes: Array<string> = []
  const remaining = Math.max(0, inputs.remainingUnits)
  if (remaining === 0) {
    return {
      timeboxSlug: inputs.slug,
      sessionsNeeded: 0,
      remainingUnits: 0,
      unitsPerSession: 0,
      sessions: [],
      notes: ["nothing to plan: done == total"],
    }
  }

  const deadlineMs = Date.parse(inputs.deadline)
  if (Number.isNaN(deadlineMs)) {
    return {
      timeboxSlug: inputs.slug,
      sessionsNeeded: 0,
      remainingUnits: remaining,
      unitsPerSession: 0,
      sessions: [],
      notes: [`invalid deadline: ${inputs.deadline}`],
    }
  }
  const taperMs = inputs.taperDays * DAY_MS
  const planEndMs = deadlineMs - taperMs
  const todayMs = startOfUtcDay(inputs.today).getTime()
  if (planEndMs <= todayMs) {
    return {
      timeboxSlug: inputs.slug,
      sessionsNeeded: 0,
      remainingUnits: remaining,
      unitsPerSession: 0,
      sessions: [],
      notes: ["deadline (minus taper) is in the past"],
    }
  }

  const weeksRemaining = Math.max(1 / 7, (planEndMs - todayMs) / (7 * DAY_MS))
  const sessionsNeeded = Math.max(1, Math.ceil(weeksRemaining * inputs.sessionsPerWeek))
  const unitsPerSession = remaining / sessionsNeeded

  const sessions: Array<PlannedSession> = []
  let cumulativeBefore = 0

  // Walk days from tomorrow up to plan-end.
  for (
    let dMs = todayMs + DAY_MS;
    dMs <= planEndMs && sessions.length < sessionsNeeded;
    dMs += DAY_MS
  ) {
    const d = new Date(dMs)
    const weekday = weekdayOf(d)
    const matchingWindows = inputs.workingWindows.filter((w) =>
      (w.days as ReadonlyArray<string>).includes(weekday),
    )
    if (matchingWindows.length === 0) continue

    // For each window on this day, try to fit one session at the window start.
    // We don't pack multiple sessions per day — sessions_per_week shapes cadence.
    for (const window of matchingWindows) {
      if (sessions.length >= sessionsNeeded) break

      const { h: sh, m: sm } = parseHM(window.start)
      const { h: eh, m: em } = parseHM(window.end)
      const windowStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sh, sm)
      const windowEndMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), eh, em)
      const sessionEndMs = windowStartMs + inputs.sessionMinutes * 60_000

      if (sessionEndMs > windowEndMs) {
        notes.push(
          `${isoDate(d)}: window ${window.start}-${window.end} too short for ${inputs.sessionMinutes}min session`,
        )
        continue
      }

      if (overlapsExistingEvent(windowStartMs, sessionEndMs, inputs.existingEvents)) {
        notes.push(`${isoDate(d)}: ${window.start} clashes with existing event — skipped`)
        continue
      }

      const isLast = sessions.length === sessionsNeeded - 1
      const units = formatUnits(inputs.unit, unitsPerSession, cumulativeBefore, isLast, remaining)
      sessions.push({
        date: isoDate(d),
        start: window.start,
        end: fmtHM(
          Math.floor(sessionEndMs / 3_600_000) % 24,
          Math.floor(sessionEndMs / 60_000) % 60,
        ),
        units,
      })
      cumulativeBefore += isLast ? remaining - cumulativeBefore : unitsPerSession
      // Only one session per day in this pass.
      break
    }
  }

  if (sessions.length < sessionsNeeded) {
    notes.push(
      `placed ${sessions.length} of ${sessionsNeeded} sessions — widen working_windows or shorten deadline`,
    )
  }

  return {
    timeboxSlug: inputs.slug,
    sessionsNeeded,
    remainingUnits: remaining,
    unitsPerSession: roundUnits(unitsPerSession),
    sessions,
    notes,
  }
}

// Build absolute ISO 8601 datetime in the given IANA tz from date + HH:MM.
// Best-effort: we emit a wall-clock-with-offset string by interpreting the
// HH:MM as the tz's local time. The kernel calendar adapter accepts any
// IsoLike pattern, so a "+HH:MM" offset is sufficient for storage.
//
// We compute the offset for the given date by formatting it in the tz and
// reading the offset back. If Intl.DateTimeFormat doesn't know the tz we
// fall back to UTC (with a `Z` suffix).
export const composeIsoInTz = (date: string, hm: string, tz: string): string => {
  const [h, m] = hm.split(":").map((s) => Number.parseInt(s, 10))
  const [Y, Mo, D] = date.split("-").map((s) => Number.parseInt(s, 10))
  const utc = Date.UTC(Y, Mo - 1, D, h, m)

  let offsetMin: number
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
    const parts = fmt.formatToParts(new Date(utc))
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT"
    const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!match) {
      offsetMin = 0
    } else {
      const sign = match[1] === "-" ? -1 : 1
      offsetMin = sign * (Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3] ?? "0", 10))
    }
  } catch {
    offsetMin = 0
  }

  const localMs = utc - offsetMin * 60_000
  const out = new Date(localMs)
  const yyyy = out.getUTCFullYear()
  const mo = String(out.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(out.getUTCDate()).padStart(2, "0")
  const hh = String(out.getUTCHours()).padStart(2, "0")
  const mm = String(out.getUTCMinutes()).padStart(2, "0")
  if (offsetMin === 0) return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00Z`
  const sign = offsetMin >= 0 ? "+" : "-"
  const absMin = Math.abs(offsetMin)
  const oh = String(Math.floor(absMin / 60)).padStart(2, "0")
  const om = String(absMin % 60).padStart(2, "0")
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00${sign}${oh}:${om}`
}
