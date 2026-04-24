/**
 * Default span (in days) applied to a Gantt bar when only one of
 * start_date / due_date is known. Anchored on due_date per spec:
 * if due_date alone is set, the bar's left edge is at due_date − DEFAULT_SPAN_DAYS.
 */
export const DEFAULT_SPAN_DAYS = 3
