/**
 * Pure, DOM-free geometry for the Gantt view.
 *
 * Anchored on raw date strings (YYYY-MM-DD) and the project's `range.min`.
 * No `getBoundingClientRect`, no timezone math — day-granularity only.
 */

export const DEFAULT_SPAN_DAYS = 3

export type ZoomMode = "day" | "week" | "month" | "quarter"

export interface ZoomConfig {
  colWidth: number
  /** Minimum drag distance before a move registers (px). */
  minDragDistance: number
  /** Snap unit in days. */
  snapDays: number
}

export const ZOOM: Record<ZoomMode, ZoomConfig> = {
  day:     { colWidth: 32,  minDragDistance: 8,  snapDays: 1 },
  week:    { colWidth: 96,  minDragDistance: 12, snapDays: 1 },
  month:   { colWidth: 180, minDragDistance: 12, snapDays: 1 },
  quarter: { colWidth: 120, minDragDistance: 16, snapDays: 7 },
}

/* ── Date helpers ─────────────────────────────────────────── */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse YYYY-MM-DD into UTC epoch-milliseconds. */
export function parseDate(s: string): number {
  const m = DATE_RE.exec(s)
  if (!m) throw new Error(`Invalid date: ${s}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Serialize an epoch-ms UTC timestamp back to YYYY-MM-DD. */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0")
  const da = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${mo}-${da}`
}

/** Days from `a` to `b` (integer, negative if b < a). */
export function daysBetween(a: string, b: string): number {
  const DAY = 86_400_000
  return Math.round((parseDate(b) - parseDate(a)) / DAY)
}

export function addDays(date: string, days: number): string {
  const DAY = 86_400_000
  return formatDate(parseDate(date) + days * DAY)
}

/* ── Bar rect ─────────────────────────────────────────────── */

export interface BarInputIssue {
  start_date?: string | null
  due_date?: string | null
}

export interface Rect {
  left: number
  width: number
}

/**
 * Compute bar's left/width in pixels for a given issue.
 *
 * - Both dates set → anchored at start_date, width = (due - start + 1) * colWidth
 * - Only start_date → width = DEFAULT_SPAN_DAYS * colWidth
 * - Only due_date   → anchored at (due_date − DEFAULT_SPAN_DAYS + 1)
 * - Neither         → returns null (caller renders in Unscheduled tray)
 */
export function barRect(
  issue: BarInputIssue,
  range: { min: string },
  colWidth: number,
  defaultSpanDays: number = DEFAULT_SPAN_DAYS,
): Rect | null {
  const start = issue.start_date ?? null
  const due = issue.due_date ?? null
  if (!start && !due) return null

  let anchor: string
  let spanDays: number
  if (start && due) {
    anchor = start
    spanDays = daysBetween(start, due) + 1
  } else if (start) {
    anchor = start
    spanDays = defaultSpanDays
  } else {
    // only due → left edge at due − (span − 1)
    anchor = addDays(due!, -(defaultSpanDays - 1))
    spanDays = defaultSpanDays
  }

  const leftDays = daysBetween(range.min, anchor)
  return {
    left: leftDays * colWidth,
    width: Math.max(1, spanDays) * colWidth,
  }
}

/* ── Snap ─────────────────────────────────────────────────── */

/** Snap a raw pixel delta to the nearest colWidth * snapDays step, in day-units. */
export function snapDeltaDays(deltaPx: number, colWidth: number, snapDays: number): number {
  const unitPx = colWidth * snapDays
  return Math.round(deltaPx / unitPx) * snapDays
}

/* ── Column axis ──────────────────────────────────────────── */

/** Total days (inclusive) in the rendered range. */
export function rangeDays(range: { min: string; max: string }): number {
  return daysBetween(range.min, range.max) + 1
}

/** Day-column header tick dates, one per day from range.min to range.max (inclusive). */
export function dayTicks(range: { min: string; max: string }): string[] {
  const n = rangeDays(range)
  const out: string[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = addDays(range.min, i)
  return out
}

/**
 * Resolve a client-space X coordinate (e.g. pointer.clientX) into a
 * project-local date on the grid's time axis.
 *
 * `gridOrigin` is the client-space X of the grid's leftmost column
 * (at range.min), accounting for scroll. Returns the date at that column.
 */
export function columnDateAt(
  clientX: number,
  gridOrigin: number,
  colWidth: number,
  range: { min: string; max: string },
): string {
  const col = Math.floor((clientX - gridOrigin) / colWidth)
  const clamped = Math.max(0, Math.min(rangeDays(range) - 1, col))
  return addDays(range.min, clamped)
}

/**
 * Keyboard-sensor coordinate getter: arrow keys snap to one column per press,
 * ROW_HEIGHT per vertical press. Returns undefined for non-arrow keys so the
 * default handler runs.
 */
export interface KeyboardArrowDeltas {
  colWidth: number
  rowHeight: number
}

export function gridCoordinateGetter(
  deltas: KeyboardArrowDeltas,
): (
  event: KeyboardEvent,
  args: { currentCoordinates: { x: number; y: number } },
) => { x: number; y: number } | undefined {
  return (event, { currentCoordinates }) => {
    switch (event.code) {
      case "ArrowRight":
        return { ...currentCoordinates, x: currentCoordinates.x + deltas.colWidth }
      case "ArrowLeft":
        return { ...currentCoordinates, x: currentCoordinates.x - deltas.colWidth }
      case "ArrowDown":
        return { ...currentCoordinates, y: currentCoordinates.y + deltas.rowHeight }
      case "ArrowUp":
        return { ...currentCoordinates, y: currentCoordinates.y - deltas.rowHeight }
    }
    return undefined
  }
}
