// Pure helpers for calendar filtering — no I/O.
// Spec: apps/uebermensch/vault/specs/calendar.md § Filter predicates.

import type { CalendarEvent, EventFilter } from "../services/CalendarService.js"

const DAY_MS = 86_400_000

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

const endOfUtcDay = (d: Date): Date =>
  new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  )

const endOfUtcMonth = (d: Date): Date => {
  // Day 0 of next month = last day of this month
  const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return endOfUtcDay(nextMonth)
}

// Spec § Filter predicates: today, tomorrow, +Nd, +Nw, eom, or YYYY-MM-DD passthrough.
// `bound` distinguishes from-vs-to so plain YYYY-MM-DD shortcuts cover the whole day.
export const parseDateShortcut = (
  s: string,
  now: Date,
  bound: "from" | "to",
): Date | null => {
  const trimmed = s.trim().toLowerCase()
  if (trimmed === "") return null

  if (trimmed === "today") {
    return bound === "from" ? startOfUtcDay(now) : endOfUtcDay(now)
  }
  if (trimmed === "tomorrow") {
    const t = new Date(now.getTime() + DAY_MS)
    return bound === "from" ? startOfUtcDay(t) : endOfUtcDay(t)
  }
  if (trimmed === "eom") {
    // 'eom' as `from` means "from start of last day of month"; usually used as a `to`.
    return bound === "from" ? startOfUtcDay(endOfUtcMonth(now)) : endOfUtcMonth(now)
  }

  // +Nd / +Nw (also accept -Nd / -Nw for symmetry, useful for "from -7d")
  const rel = trimmed.match(/^([+-]?)(\d+)(d|w)$/)
  if (rel) {
    const sign = rel[1] === "-" ? -1 : 1
    const n = Number.parseInt(rel[2], 10)
    const days = rel[3] === "w" ? n * 7 : n
    const t = new Date(now.getTime() + sign * days * DAY_MS)
    return bound === "from" ? startOfUtcDay(t) : endOfUtcDay(t)
  }

  // Plain ISO date / datetime — passthrough; a bare YYYY-MM-DD covers the whole day.
  const isoBare = trimmed.match(/^\d{4}-\d{2}-\d{2}$/)
  if (isoBare) {
    const d = new Date(`${trimmed}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return null
    return bound === "from" ? d : endOfUtcDay(d)
  }
  const full = new Date(s.trim())
  if (Number.isNaN(full.getTime())) return null
  return full
}

const intersects = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string>,
): boolean => {
  if (!a || a.length === 0) return false
  for (const x of a) if (b.includes(x)) return true
  return false
}

const eventTime = (e: CalendarEvent): number => {
  // For all-day or bare-date starts_at, parse as UTC start-of-day.
  const s = e.startsAt
  const isBare = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const ms = new Date(isBare ? `${s}T00:00:00Z` : s).getTime()
  return Number.isFinite(ms) ? ms : 0
}

export const matchesFilter = (e: CalendarEvent, f: EventFilter | undefined): boolean => {
  if (!f) return true
  if (f.source && f.source.length > 0 && !f.source.includes(e.source)) return false
  if (f.kind && f.kind.length > 0 && !f.kind.includes(e.kind)) return false
  if (f.status && f.status.length > 0 && !f.status.includes(e.status)) return false

  if (f.from || f.to) {
    const t = eventTime(e)
    if (f.from) {
      const fromMs = new Date(f.from).getTime()
      if (Number.isFinite(fromMs) && t < fromMs) return false
    }
    if (f.to) {
      const toMs = new Date(f.to).getTime()
      if (Number.isFinite(toMs) && t > toMs) return false
    }
  }

  if (f.tickers && f.tickers.length > 0 && !intersects(e.tickers, f.tickers)) return false
  if (f.topics && f.topics.length > 0 && !intersects(e.topics, f.topics)) return false
  if (f.theses && f.theses.length > 0 && !intersects(e.theses, f.theses)) return false
  if (f.tags && f.tags.length > 0 && !intersects(e.tags, f.tags)) return false

  if (f.q && f.q.length > 0) {
    const needle = f.q.toLowerCase()
    const hay = `${e.title}\n${e.body}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }

  return true
}

// Stable display order: by event start time ascending.
export const sortByStart = (events: ReadonlyArray<CalendarEvent>): ReadonlyArray<CalendarEvent> =>
  [...events].sort((a, b) => eventTime(a) - eventTime(b))
