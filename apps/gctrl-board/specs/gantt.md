# Gantt View — gctrl-board

Timeline visualization for **Issues**, complementary to the existing Kanban view. Modeled on GitHub Projects' "Roadmap" layout: horizontal bars per Issue on a time axis, grouped by a chosen field (status, assignee, milestone, parent), with direct-manipulation drag-and-drop for scheduling and reassignment.

**Scope: Issues only.** The Gantt does not render Tasks — not even read-only. Tasks are a Scheduler primitive whose timing is an execution detail of how an Issue gets done; humans reason in Issues, and the Gantt is a human planning surface. Task-level visualization, if ever needed, belongs in an agent-execution view, not here. See "Tasks are out of scope" below.

Drag-and-drop is implemented with [`@dnd-kit`](https://github.com/clauderic/dnd-kit) — the same library already used by `KanbanBoard.tsx`, so sensors, keyboard accessibility, and overlay patterns stay consistent across views.

## Goals

1. Give humans a time-anchored view of committed Issue work across a project.
2. Make rescheduling (move, resize, reparent) a one-gesture interaction.
3. Surface dependency structure — `blockedBy` / `blocking` — as visible arrows between bars, so conflicts and critical paths are obvious.
4. Preserve the invariants from `architecture.md`: Tasks remain read-only; kernel SQLite is the source of truth; the Worker is a facade.

## Non-Goals

- Resource-leveling or auto-scheduling. Humans decide dates; the Tracker only validates.
- **Task rendering of any kind** (read-only bars, sub-bars, overlays, collapsed summaries). Tasks are out of scope — see dedicated section below.
- Critical-path math. We render dependencies but do not compute slack / float in v1.
- External sync of start/end dates to GitHub/Linear in v1. Dates are gctrl-local until a driver opts in (future work — see "Open questions").

## User Stories

- **As a PM**, I can see every Issue for a project as a bar on a timeline, grouped by status, so I can spot work clustered in one status lane.
- **As an IC**, I can drag an Issue bar to shift its dates, or drag its left/right edge to extend/compress duration, without leaving the view.
- **As a triager**, I can drag an Issue from one swimlane row to another to reassign it (e.g., change assignee, change milestone) in a single gesture.
- **As a reviewer**, I can see `blockedBy` arrows pointing into an Issue so I know what must ship first.

## Comparison to GitHub Projects Roadmap

| Capability                          | GitHub Projects Roadmap | gctrl-board Gantt v1                          |
|-------------------------------------|-------------------------|-----------------------------------------------|
| Bar per issue on time axis          | ✅                      | ✅                                            |
| Start / Target date fields          | ✅                      | ✅ (new `start_date`, `due_date` on Issue)    |
| Drag to move                        | ✅                      | ✅ (`@dnd-kit` `useDraggable`)                |
| Drag edge to resize                 | ✅                      | ✅ (custom edge-handle draggables)            |
| Group by field (status/iteration)   | ✅                      | ✅ (status, assignee, parent, milestone)      |
| Zoom (day/week/month/quarter)       | ✅                      | ✅ (day, week, month, quarter)                |
| Dependency arrows                   | ❌                      | ✅ (SVG overlay over bars)                    |
| Milestones as vertical markers      | ✅                      | Deferred (v2)                                 |
| Iteration columns                   | ✅                      | Deferred — we rely on `parent_id` for epics   |

## Data Model Changes

Add two optional date fields to `Issue`. Both are `YYYY-MM-DD` (date-only, local to the project, no TZ ambiguity for day-granularity bars).

### Schema (Effect-TS) — `apps/gctrl-board/src/schema/Issue.ts`

```typescript
export const Issue = Schema.Struct({
  // ... existing fields ...
  startDate: Schema.optional(Schema.String), // YYYY-MM-DD
  dueDate:   Schema.optional(Schema.String), // YYYY-MM-DD
})
```

### Migration — `apps/gctrl-board/migrations/0003_gantt_dates.sql`

```sql
ALTER TABLE issues ADD COLUMN start_date TEXT;
ALTER TABLE issues ADD COLUMN due_date   TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_start_date ON issues(start_date);
CREATE INDEX IF NOT EXISTS idx_issues_due_date   ON issues(due_date);
```

Both nullable — existing Issues appear in an "Unscheduled" tray (see "Layout") until dated.

### Validation rules (Tracker)

- If both set, `start_date <= due_date`. Reject the mutation otherwise.
- Either field may be set alone. A bar without `start_date` anchors its left edge at `due_date - default_span` (default span = 3 days, configurable per project).
- Status transitions do **not** clear or auto-set dates. Dates are a separate concern from lifecycle.

## Kernel HTTP API

Per the "Kernel is source of truth; Worker is facade" feedback, new routes live on the kernel and the Worker simply proxies. No direct D1 writes for scheduling.

### New endpoints

| Method | Path                                          | Purpose                                      |
|--------|-----------------------------------------------|----------------------------------------------|
| `PATCH`| `/api/board/issues/{id}/schedule`             | Update `start_date` and/or `due_date`        |
| `GET`  | `/api/board/projects/{id}/gantt`              | Projected view: issues + dependency edges    |

#### `PATCH /api/board/issues/{id}/schedule`

Request body:

```json
{ "start_date": "2026-05-01", "due_date": "2026-05-14" }
```

Either field may be `null` to clear. Validates the ordering rule above. Emits an `issue_events` row of type `scheduled` with the delta as `data`.

#### `GET /api/board/projects/{id}/gantt`

Response shape (tuned for the Gantt view — avoids N+1 over individual issue fetches):

```json
{
  "range": { "min": "2026-04-01", "max": "2026-06-30" },
  "issues": [ { "id": "...", "title": "...", "status": "...", "start_date": "...", "due_date": "...", "assignee_id": "...", "parent_id": "...", "priority": "..." } ],
  "dependencies": [ { "from_issue_id": "...", "to_issue_id": "...", "kind": "blocked_by" } ]
}
```

`range` is computed from the min/max of scheduled dates in the project, clamped to at least one zoom window. Unscheduled Issues are returned with null dates so the client can render them in the "Unscheduled" tray.

## Frontend

New component: `apps/gctrl-board/web/src/components/GanttBoard.tsx`, reachable from the existing view-switcher (sibling of `KanbanBoard`). Route: `/projects/:projectKey/gantt`.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Zoom: [Day][Week][Month][Quarter]   Group by: [Status ▾]   │
├──────────────┬──────────────────────────────────────────────┤
│ Swimlane hdr │  ← time axis (days) ───────────────────────→ │
├──────────────┼──────────────────────────────────────────────┤
│ Backlog      │       ░░░░░░░░                               │
│   BACK-12    │       ████████      ← draggable bar          │
│   BACK-17    │                 ██████████                   │
├──────────────┼──────────────────────────────────────────────┤
│ In Progress  │  ██████████████  ← "today" vertical line     │
│   BACK-42    │  ├──→ arrow to BACK-17 (blocking)            │
├──────────────┼──────────────────────────────────────────────┤
│ Unscheduled  │  [card] [card] [card]   ← drop target tray   │
└──────────────┴──────────────────────────────────────────────┘
```

- Time axis: day column width depends on zoom. Sticky header.
- Swimlanes: rows grouped by the `Group by` field. Drop between rows = reassign that grouping field.
- Unscheduled tray: horizontal strip of undated cards. Dragging a card onto the time grid sets `start_date` to the drop x-coordinate; default span applied if no `due_date` exists.
- Today marker: a vertical line at today's column, always visible.
- Dependency arrows: an absolutely-positioned SVG overlay renders one `<path>` per `blockedBy` edge between bars. Arrows recompute on layout changes (row reorder, resize, zoom).

### @dnd-kit integration

We use three distinct draggable "kinds" so handlers can dispatch cleanly:

| Drag kind      | `useDraggable` data          | `useDroppable` targets                      | Effect                                                |
|----------------|------------------------------|---------------------------------------------|-------------------------------------------------------|
| `bar-move`     | `{ issueId, kind: "move" }`  | Day cells in any swimlane                   | Shift `start_date` (and `due_date` by same delta)     |
| `bar-resize-l` | `{ issueId, kind: "l" }`     | Day cells in the same row                   | Update `start_date` only                              |
| `bar-resize-r` | `{ issueId, kind: "r" }`     | Day cells in the same row                   | Update `due_date` only                                |
| `unscheduled`  | `{ issueId, kind: "fresh" }` | Day cells in any swimlane                   | Set `start_date` to drop column; apply default span   |

All four share a single `<DndContext>` with a `PointerSensor` (same `activationConstraint: { distance: 8 }` as KanbanBoard) and a `KeyboardSensor` for a11y. `DragOverlay` renders a translucent bar following the cursor.

Droppables are the individual day columns inside each swimlane row, keyed by `"{rowKey}::{YYYY-MM-DD}"`. On `onDragEnd` we parse the `over.id`, compute the new dates, optimistically update local state, and call `PATCH /schedule`. On failure, we roll back and surface a toast — same pattern `useBoard.moveIssue` already uses.

Dragging a bar's row in the swimlane direction (vertical) reassigns the grouping field (e.g., changes `status`, `assignee_id`, or `parent_id`). That path reuses the existing `PATCH /issues/{id}` endpoint — not the schedule endpoint.

### Rendering the bars

- Bar left = `(start_date − range.min) * colWidth`.
- Bar width = `(due_date − start_date + 1) * colWidth`, min 1 column.
- Color = status accent (reuse `COLUMN_ACCENT` from `KanbanBoard.tsx`).
- Label = `{project.key}-{issue.counter}  ·  {title}` truncated to bar width.
- Hover reveals an `IssueDetailPanel` popover (reuse existing component).

### State & hooks

New hook `useGantt(projectId)`:

```ts
export function useGantt(projectId: string): {
  data: GanttView | null
  loading: boolean
  updateSchedule: (id: string, patch: SchedulePatch) => Promise<void>
  moveAcrossSwimlane: (id: string, groupField: string, groupValue: string) => Promise<void>
}
```

Backed by a single `GET /projects/:id/gantt` fetch + optimistic local reducer. Reuses `useProjectRoute` for the current project.

## Tasks are out of scope

The Gantt renders **Issues only**. Tasks (Scheduler primitives) do not appear in this view in any form — no sub-bars, no hover reveals, no collapsed summaries, no badges. The rationale:

1. **Humans plan in Issues.** The Gantt is a planning surface for committed, team-visible work. Tasks are how an agent internally decomposes an Issue — an execution detail, not a planning unit.
2. **Task timing is Scheduler-owned and ephemeral.** A Task's `start`/`end` is determined by agent runtime, can change within seconds, and is meaningless outside the session that produced it. Surfacing it on a time axis designed for days-to-months invites misreading.
3. **Invariant preservation.** `architecture.md` defines Tasks as read-only in the Kanban lane; the simplest way to respect that here is to not render them at all.
4. **Scope discipline.** Every Task-adjacent feature (collapsible sub-bars, disclosure carets, muted colors, Scheduler-fetch plumbing) adds cost without serving the planning use case.

If an agent-execution timeline is ever needed, it belongs in a separate view (e.g., per-session trace visualization already implied by `gctl sessions tree`), not bolted onto the Issue Gantt.

## Testing

Following the project's test pyramid (unit → integration → acceptance → soak).

### Unit — `web/src/components/__tests__/GanttBoard.test.tsx`
- Bar position math for every zoom level.
- Default-span fallback when only `start_date` or only `due_date` is set.
- Dependency arrow path geometry given two bar rects.

### Integration — `test/gantt.test.ts` (vitest + Worker)
- `PATCH /schedule` rejects `start_date > due_date`.
- `PATCH /schedule` with `null` clears the field.
- `GET /projects/:id/gantt` returns correct `range` and omits archived Issues.
- Scheduled event emitted to `issue_events`.

### Acceptance — `tests/acceptance/gantt.spec.ts` (Playwright + Miniflare)
- User loads Gantt view, drags a bar 3 columns right, observes persisted dates after reload.
- User drags left edge — only `start_date` changes.
- User drags a card from Unscheduled tray onto the grid — bar appears at drop column.
- User drags a bar between swimlanes when grouped by `status` — status transitions via existing move endpoint (exercises the two-endpoint routing inside `onDragEnd`).
- Keyboard-only path: `Tab` to a bar, `Space` to pick up, arrows to move, `Space` to drop — uses `@dnd-kit`'s `KeyboardSensor`.

## Implementation Phases

1. **Data + API** — migration `0003_gantt_dates.sql`, `PATCH /schedule`, `GET /gantt`, unit + integration tests.
2. **Static render** — `GanttBoard.tsx` with time axis, swimlanes, bars, today marker. No dragging yet.
3. **Drag to move / resize** — `@dnd-kit` wiring, optimistic updates, rollback on failure.
4. **Dependency arrows** — SVG overlay, recompute on layout changes.
5. **Unscheduled tray + swimlane drag** — reassignment path.
6. **Accessibility pass** — keyboard sensor, ARIA for bars, focus ring.
7. **Acceptance tests** — Playwright suite above.

Each phase lands as its own PR.

## Open Questions

- **Iteration field**: GitHub Projects has first-class iterations (2-week windows). Should we model iterations or keep relying on `parent_id` for epic grouping? Deferring; revisit after dogfooding v1.
- **External sync**: Should `start_date` / `due_date` sync bidirectionally to GitHub Projects via `driver-github`? GitHub Project v2 supports date fields via GraphQL; viable but out of scope for v1.
- **Milestones**: Do we render project milestones as vertical markers? Depends on whether we add a `board_milestones` table. Deferred to v2.
- **Working days**: Should weekends be collapsible in Day zoom? Default to showing all days; revisit if users complain.

## Related

- `architecture.md` — Tasks are read-only; kernel SQLite is source of truth.
- `tracker.md` — Issue lifecycle and DAG; dates are orthogonal to status transitions.
- `../../specs/gctrl/workflows/issue-lifecycle.md` — Lifecycle events that the Gantt view reacts to (status color on bars).
- `@dnd-kit` docs: <https://docs.dndkit.com/>
