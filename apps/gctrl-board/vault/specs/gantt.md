# Gantt View — gctrl-board

Timeline visualization for **Issues**, complementary to the existing Kanban view. Modeled on GitHub Projects' "Roadmap" layout: horizontal bars per Issue on a time axis, grouped by status, with direct-manipulation drag-and-drop for scheduling and reassignment.

**Scope: Issues only.** The Gantt does not render Tasks — not even read-only. Tasks are a Scheduler primitive whose timing is an execution detail of how an Issue gets done; humans reason in Issues, and the Gantt is a human planning surface. See "Tasks are out of scope" below.

Drag-and-drop is implemented with [`@dnd-kit`](https://github.com/clauderic/dnd-kit) — the same library `KanbanBoard.tsx` already uses, so sensors, keyboard accessibility, and overlay patterns stay consistent across views.

## Goals

1. Give humans a time-anchored view of committed Issue work across a project.
2. Make rescheduling (move, resize) a one-gesture interaction.
3. Preserve the invariants from `architecture.md`: Tasks remain read-only; kernel SQLite is the source of truth; the Worker is a facade.

## Non-Goals

- Resource-leveling or auto-scheduling. Humans decide dates; the Tracker only validates.
- **Task rendering of any kind** (see "Tasks are out of scope").
- **Dependency arrows** between bars — deferred to v2. GitHub Projects Roadmap does not draw them; `blockedBy` / `blocking` remain surfaced in `IssueDetailPanel` only.
- **External sync.** Dates are gctrl-local and stay gctrl-local. We are **not** syncing `start_date` / `due_date` to GitHub Projects, Linear, or any other tracker — not in v1, not in v2. If a user wants timeline data in GitHub, they can read it through the gctrl shell.
- Critical-path math. No slack / float.
- Milestones as first-class markers (no schema, no UI).
- Multi-select bar drag.

## User Stories

- **As a PM**, I can see every Issue for a project as a bar on a timeline, grouped by status, so I can spot work clustered in one status lane.
- **As an IC**, I can drag an Issue bar to shift its dates, or drag its left/right edge to extend/compress duration, without leaving the view.
- **As a triager**, I can drag an Issue from one status swimlane to another in a single gesture — reusing the same endpoint the Kanban uses.
- **As a planner**, I can drag an undated Issue from the "Unscheduled" tray onto the grid to schedule it.

## Comparison to GitHub Projects Roadmap

| Capability                          | GitHub Projects Roadmap | gctrl-board Gantt v1                          |
|-------------------------------------|-------------------------|-----------------------------------------------|
| Bar per issue on time axis          | ✅                      | ✅                                            |
| Start / Target date fields          | ✅                      | ✅ (new `start_date`, `due_date` on Issue)    |
| Drag to move                        | ✅                      | ✅ (`@dnd-kit` `useDraggable`)                |
| Drag edge to resize                 | ✅                      | ✅ (edge-handle draggables)                   |
| Group by status                     | ✅                      | ✅                                            |
| Group by assignee / iteration       | ✅                      | Deferred (v2)                                 |
| Zoom (day/week/month/quarter)       | ✅                      | ✅                                            |
| Unscheduled tray                    | ✅                      | ✅                                            |
| Dependency arrows                   | ❌                      | Deferred (v2)                                 |
| Milestones as vertical markers      | ✅                      | Deferred (v2)                                 |
| Iteration columns                   | ✅                      | Deferred (v2)                                 |

## Data Model Changes

Add two optional date fields to `Issue`. Both are `YYYY-MM-DD` (date-only, project-local, no TZ ambiguity for day-granularity bars).

### Effect-TS struct — `apps/gctrl-board/src/schema/Issue.ts`

```typescript
export const Issue = Schema.Struct({
  // ... existing fields ...
  startDate: Schema.optional(Schema.String), // YYYY-MM-DD
  dueDate:   Schema.optional(Schema.String), // YYYY-MM-DD
})
```

### SQL migration — `apps/gctrl-board/migrations/0003_gantt_dates.sql`

```sql
ALTER TABLE issues ADD COLUMN start_date TEXT;
ALTER TABLE issues ADD COLUMN due_date   TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_start_date ON issues(start_date);
CREATE INDEX IF NOT EXISTS idx_issues_due_date   ON issues(due_date);
```

The same migration lands in `kernel/migrations/` for SQLite. Both nullable — existing Issues appear in the "Unscheduled" tray until dated.

### Case convention

The current Worker serves snake_case to the frontend (see `web/src/types.ts` — `assignee_id`, `created_at`, etc.). We lock the same convention:

- **DB columns** (D1 + SQLite): `start_date`, `due_date` (snake_case).
- **HTTP payloads** (request + response): `start_date`, `due_date` (snake_case).
- **Effect-TS domain struct**: `startDate`, `dueDate` (camelCase). Transform happens in the existing struct ↔ row codec — same place `createdAt` ↔ `created_at` is already handled.
- **React types** (`web/src/types.ts`): `start_date`, `due_date` (snake_case, matches existing fields).

### Validation rules (Tracker)

- If both set, `start_date <= due_date`. Reject otherwise with `InvalidScheduleError`.
- Either field may be set alone. Rendering rule: if only `due_date` is set, the bar anchors its left edge at `due_date − DEFAULT_SPAN_DAYS` (constant, value `3`, defined in `services/constants.ts`). Not per-project configurable in v1.
- Status transitions neither clear nor auto-set dates.
- `cancelled` Issues render as strikethrough muted bars and are **not draggable** (`readonlyDates: true` flag on the bar — borrowed from frappe/gantt's `readonly_dates`). `done` is draggable (so historical re-dating for auditing is possible).

## HTTP API — kernel is source of truth, Worker mirrors

The board already has parallel route surfaces on kernel (`kernel/crates/gctrl-otel/src/receiver.rs`) and Worker (`apps/gctrl-board/src/worker.ts`) — e.g. both expose `POST /api/board/issues/:id/move`. We follow the same dual-surface pattern:

```
                   ┌────────────────────────────────────────┐
                   │ Client (web / shell)                   │
                   └──────────┬──────────┬──────────────────┘
                      local   │          │ edge
                              ▼          ▼
               ┌──────────────────┐  ┌────────────────────┐
               │ Kernel (SQLite)  │  │ Worker (D1)        │
               │ receiver.rs      │  │ worker.ts          │
               │ PATCH /schedule  │  │ PATCH /schedule    │
               │ GET  /gantt      │  │ GET  /gantt        │
               └────────┬─────────┘  └─────────┬──────────┘
                        └───── sync channel ───┘
                      (existing multi-device sync,
                       via 0002_sync_columns — no new code)
```

- **Kernel SQLite is the source of truth.** PRs land the new handlers in `receiver.rs` first.
- **Worker D1 mirrors the same routes** for edge access (this is what the web app calls today — the dogfooded board runs against the Worker). Schema mirroring is the existing pattern.
- The existing multi-device sync (columns added in `0002_sync_columns.sql`) carries `start_date` / `due_date` across replicas without spec-specific work. We only need to extend the mirror write path in `services/BoardService.ts`.

### Endpoints (added to both surfaces)

| Method  | Path                                          | Purpose                                      |
|---------|-----------------------------------------------|----------------------------------------------|
| `PATCH` | `/api/board/issues/{id}/schedule`             | Update `start_date` and/or `due_date`        |
| `GET`   | `/api/board/projects/{id}/gantt`              | Issues + date range for a project            |

#### `PATCH /api/board/issues/{id}/schedule`

Request:

```json
{ "start_date": "2026-05-01", "due_date": "2026-05-14" }
```

Either field may be `null` to clear. Validates `start_date <= due_date`. On success, emits an `issue_events` row with `event_type = "scheduled"` and `data = { start_date, due_date }`.

**Concurrency**: last-write-wins — same policy the existing Kanban `POST /issues/:id/move` uses. No `If-Match` / `updated_at` precondition in v1. (If we need optimistic-concurrency later, we extend both routes at once.)

#### `GET /api/board/projects/{id}/gantt`

Response (snake_case, Gantt-tuned to avoid N+1 over individual issue fetches):

```json
{
  "range": { "min": "2026-04-01", "max": "2026-06-30" },
  "issues": [
    {
      "id": "...",
      "project_id": "...",
      "title": "...",
      "status": "todo",
      "priority": "medium",
      "assignee_id": "...",
      "assignee_name": "...",
      "assignee_type": "human",
      "parent_id": "...",
      "start_date": "2026-05-01",
      "due_date":   "2026-05-14"
    }
  ]
}
```

- `range` is the raw min/max of scheduled dates in the project. **No server-side zoom clamping** — padding is a client concern (the client extends `range` to align with the current zoom window and always includes "today").
- Unscheduled Issues are returned with `null` dates for the tray.
- No `dependencies` field in v1 (arrows deferred to v2).
- Archived Issues are not a concept in the current schema — this was wrong in the previous draft and is dropped.

## Frontend

New component: `apps/gctrl-board/web/src/components/GanttBoard.tsx`, reachable from a view-switcher alongside `KanbanBoard`. Route: `/projects/:projectKey/gantt`.

### Rendering approach

- **Bars are DOM**, not SVG — each bar is an absolutely-positioned `<div>` inside its swimlane row. `@dnd-kit` works with DOM refs directly; hover / focus / popover reuse `IssueCard` + `IssueDetailPanel` without an SVG↔DOM event bridge.
- Time axis is a simple CSS grid (sticky header) with `colWidth` driven by the zoom mode.
- The "today" line is a single absolutely-positioned div overlay on the grid.
- SVG is **reserved for v2 dependency arrows** only.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Zoom: [Day][Week][Month][Quarter]   (Group by: Status)     │
├──────────────┬──────────────────────────────────────────────┤
│ Swimlane hdr │  ← time axis (sticky) ─────────────────────→ │
├──────────────┼──────────────────────────────────────────────┤
│ Backlog      │                                              │
│   BACK-12    │       ████████      ← draggable bar          │
│   BACK-17    │                 ██████████                   │
├──────────────┼──────────────────────────────────────────────┤
│ In Progress  │  ██████████████  ┆ "today" line              │
│   BACK-42    │                  ┆                            │
├──────────────┼──────────────────────────────────────────────┤
│ Unscheduled  │  [card] [card] [card]   ← drop target tray   │
└──────────────┴──────────────────────────────────────────────┘
```

### Zoom modes & snap policy (borrowed from frappe/gantt `snap_at`)

| Zoom     | `colWidth` | Snap unit | Min drag distance |
|----------|------------|-----------|-------------------|
| Day      | 32 px      | 1 day     | 8 px (½ column)   |
| Week     | 96 px      | 1 day     | 12 px             |
| Month    | 180 px     | 1 day     | 12 px             |
| Quarter  | 120 px     | 1 week    | 16 px             |

Explicit snap + min-distance eliminates the "1px drag = 1 week shift at Quarter zoom" risk. Snap unit applies to both bar-move and bar-resize.

**Why Day is the smallest unit** (frappe/gantt ships Hour / Quarter Day / Half Day variants; we don't): Issues are human-planned units of work tracked at day granularity (`start_date` / `due_date` are `YYYY-MM-DD`). Sub-day timing belongs to Tasks, which are out of scope for the Gantt. Day / Week / Month / Quarter covers sprint, release, and roadmap horizons without surfacing execution-detail noise.

### @dnd-kit integration

Four draggable kinds dispatch cleanly in `onDragEnd`:

| Drag kind      | `useDraggable` data          | `useDroppable` targets            | Effect                                            |
|----------------|------------------------------|-----------------------------------|---------------------------------------------------|
| `bar-move`     | `{ issueId, kind: "move" }`  | Day cells in any swimlane         | Shift `start_date` + `due_date` by same delta; if dropped in a *different swimlane*, status also changes (see axis rule). |
| `bar-resize-l` | `{ issueId, kind: "l" }`     | Day cells in the **same row**     | Update `start_date` only.                         |
| `bar-resize-r` | `{ issueId, kind: "r" }`     | Day cells in the **same row**     | Update `due_date` only.                           |
| `unscheduled`  | `{ issueId, kind: "fresh" }` | Day cells in any swimlane         | Set `start_date = drop_column`, `due_date = drop_column + DEFAULT_SPAN_DAYS − 1`; if the drop row's status differs, status also changes. |

All four share one `<DndContext>` with a `PointerSensor` (`activationConstraint: { distance: 8 }`) and a `KeyboardSensor`. Droppable IDs: `"{status}::{YYYY-MM-DD}"`.

#### Axis disambiguation rule (cross-row + cross-column drops)

When a `bar-move` or `unscheduled` drop lands in a row AND a column that both differ from the source, **both axes apply**:

1. The date change persists via `PATCH /schedule`.
2. The status change persists via the existing `POST /issues/:id/move` — same call the Kanban makes. Two network calls, issued in parallel; if the status call fails, we roll back the status but keep the date change (and surface the partial-failure state in a toast). If the date call fails, we roll back both (since the user's gesture implied an atomic intent).

This matches how the Kanban already handles cross-status drops and avoids inventing a new multi-field endpoint.

#### `DragOverlay` per kind

One `<DragOverlay>`, but it renders different content based on `active.data.current.kind`:

- `bar-move` / `unscheduled`: translucent bar matching the source bar's width.
- `bar-resize-l` / `bar-resize-r`: a 2px-wide vertical guide line at the drop column.

#### Touch / hit targets

Edge handles are **12 px hit targets** rendered as **4 px visual guides**, per Apple HIG minimum-tap guidance. A `TouchSensor` is registered alongside `PointerSensor` (`delay: 150`, `tolerance: 5`) so tap-hold picks up a bar on touch devices without accidentally grabbing on a scroll.

### State & hooks

New hook `useGantt(projectId)`:

```ts
export function useGantt(projectId: string): {
  data: GanttView | null
  loading: boolean
  updateSchedule: (
    issueId: string,
    patch: { start_date?: string | null; due_date?: string | null }
  ) => Promise<void>
  moveStatus: (issueId: string, newStatus: IssueStatus) => Promise<void>
}
```

Naming borrowed from frappe/gantt's `on_date_change(task, start, end)`. Optimistic updates follow the same pattern `useBoard.moveIssue` uses. On failure, we revert local state and render an error row in the existing toast area (`<Toaster/>` in `App.tsx`).

### Bar geometry (pure functions, unit-testable)

Extracted to `web/src/lib/gantt-geom.ts`:

```ts
export function barRect(
  issue: Pick<Issue, "start_date" | "due_date">,
  range: { min: string },
  colWidth: number,
): { left: number; width: number }
```

No DOM access, no `getBoundingClientRect`. Easy to unit-test.

Keyboard-sensor snap:

```ts
export function gridCoordinateGetter(colWidth: number): KeyboardCoordinateGetter
```

Arrow keys move by one snap-unit column; documented so acceptance tests can assert exact pixel deltas.

## Tasks are out of scope

The Gantt renders **Issues only**. Tasks (Scheduler primitives) do not appear — no sub-bars, no hover reveals, no collapsed summaries, no badges. Rationale:

1. **Humans plan in Issues.** Tasks are how an agent internally decomposes an Issue — an execution detail.
2. **Task timing is Scheduler-owned and ephemeral.** A Task's `start` / `end` is determined by agent runtime and can change within seconds.
3. **Invariant preservation.** `architecture.md` defines Tasks as read-only in Kanban; the simplest way to respect that here is to not render them at all.

If an agent-execution timeline is ever needed, it belongs in a separate view (e.g., per-session trace visualization implied by `gctl sessions tree`), not bolted onto the Issue Gantt.

## Testing

### Unit — `web/src/lib/__tests__/gantt-geom.test.ts` + `web/src/components/__tests__/GanttBoard.test.tsx`

- `barRect` for every zoom level and every anchor case (both dates / only start / only due).
- `gridCoordinateGetter` returns exact `colWidth`-multiple deltas for arrow keys.
- Axis-disambiguation dispatcher: given a synthetic `DragEndEvent`, it issues the correct combination of `updateSchedule` + `moveStatus` calls (mocked hook).

### Integration — `test/gantt.test.ts` (vitest + Miniflare, Worker surface)

- `PATCH /schedule` rejects `start_date > due_date` with `400`.
- `PATCH /schedule` with `null` clears the field.
- `PATCH /schedule` emits an `issue_events` row with `event_type = "scheduled"`.
- `GET /projects/:id/gantt` returns `range` as raw min/max over scheduled dates.
- `GET /projects/:id/gantt` returns Issues with null dates for the Unscheduled tray.
- Cancelled issues are returned but flagged such that the client knows to render them `readonly` — or (simpler) the API returns them unchanged and the client applies `readonly` based on `status === "cancelled"`. Test asserts client-side behavior in the acceptance suite.

### Integration — `kernel/crates/gctrl-otel/tests/board_schedule.rs`

Mirror the Worker tests against the kernel receiver, using the same `board_move_triggers_task.rs` harness.

### Acceptance — `tests/acceptance/gantt.spec.ts` (Playwright + Miniflare)

- Drag a bar 3 snap-units right → reload → dates persisted with the correct delta.
- Drag left edge → only `start_date` changes (assert DOM + API call).
- Drag a card from Unscheduled tray → bar appears at drop column with default span.
- Drag a bar from `todo` swimlane to `in_progress` at a different column → both status AND date change; both network calls issued.
- Simulated `PATCH /schedule` failure → bar snaps back to original position; toast contains the issue key.
- Cancelled bar is not draggable (pointer events down do not trigger a drag).
- Keyboard: `Tab` to a bar, `Space` picks up, `ArrowRight × 3` moves by `3 × colWidth` at Day zoom, `Space` drops and persists.

## Implementation Phases

Collapsed to 3 PRs (down from 6):

1. **Data + API** — migration `0003_gantt_dates.sql` (both D1 and kernel SQLite), `PATCH /schedule`, `GET /gantt` on both surfaces, unit + integration tests. No frontend.
2. **Static render** — `GanttBoard.tsx` with time axis, status swimlanes, bars, today marker, Unscheduled tray. No dragging yet. Ships behind a view-switcher toggle.
3. **Drag interactions + a11y** — four drag kinds, `DragOverlay`, snap policy, axis-disambiguation dispatcher, `KeyboardSensor` with `gridCoordinateGetter`, touch handles, Playwright acceptance suite.

v2 (separate spec, separate PRs): dependency arrows, assignee/iteration grouping, milestones as markers, working-days toggle.

## Related

- `architecture.md` — Tasks are read-only; kernel SQLite is source of truth.
- `tracker.md` — Issue lifecycle and DAG; dates are orthogonal to status transitions.
- `../../specs/gctrl/workflows/issue-lifecycle.md` — lifecycle events the Gantt view reacts to (status color on bars).
- [frappe/gantt](https://github.com/frappe/gantt) — reference implementation we borrow `snap_at`, `readonly_dates`, and `on_date_change` naming from (but not the SVG rendering or custom drag code).
- `@dnd-kit` docs: <https://docs.dndkit.com/>
