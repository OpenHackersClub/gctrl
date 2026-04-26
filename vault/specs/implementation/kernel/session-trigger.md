# Session Trigger — Implementation (Slice 1: Local)

Implementation plan for the Slice 1 subset of [architecture/session-trigger-from-board.md](../../architecture/session-trigger-from-board.md): drag-to-`in_progress` on a locally-run gctrl-board → local kernel promotes Issue to Task → orchestrator dispatches `claude-code` via `local-process`. Slices 2 (CF Containers compute) and 3 (cloud orchestrator) are out of scope for this doc.

> **Dependency note:** The `gctrl-orch` crate in [orchestrator.md](orchestrator.md) is marked `[deferred]`. Slice 1 lands the **trigger side** (promotion + intent recording) plus a **stub orchestrator** that owns just enough state for the acceptance test to observe a session. The full claim-state machine ships in a follow-up PR.

---

## Scope

| In | Out |
|----|-----|
| HTTP side-effects on `POST /api/board/issues/:id/move` when `status == "in_progress"` | CF Containers compute |
| Promote-or-reuse linked Task row + emit `task.promoted_from_issue` span | Deployed orchestrator on Workers |
| Orchestrator stub that reads `task.dispatchable` and inserts a `sessions` row | Full claim-state machine from `kernel/orchestrator.md` |
| AgentRuntime / ComputeBackend traits in `gctrl-core` (no adapter impls yet — just the abstractions) | Real Claude Code process launch (stub runtime for tests) |
| `GET /api/sessions?issue_id=X` filter support | OTLP ingestion hookup for Containers |

---

## Crate / File Touch List

### `kernel/crates/gctrl-core/`
- `src/types.rs` — new structs: `Task`, `TaskDispatchability`, `AgentRuntimeKind`, `ComputeKind`.
- `src/ports.rs` (new) — trait `AgentRuntime`, trait `ComputeBackend`, struct `Invocation`, struct `ComputeHandle`. No impls.

### `kernel/crates/gctrl-storage/`
- `src/schema.rs` — new table `tasks` (if not already present) + FK from `tasks` to `board_issues`. Migrate existing `sessions` to allow `task_id: VARCHAR NULL` column.
- `src/sqlite_store.rs`:
  - New: `promote_issue_to_task(issue_id: &str, agent_kind: &str) -> Result<Task>` — inserts or reuses.
  - New: `list_dispatchable_tasks() -> Result<Vec<Task>>` — reads rows where `orchestrator_claim == 'Unclaimed'`.
  - Modify: `update_board_issue_status` — when `new_status == "in_progress"`, also call `promote_issue_to_task` inside the same transaction and return the resulting `Task` via a new overload.

### `kernel/crates/gctrl-otel/`
- `src/receiver.rs`:
  - `board_move_issue` — detect `in_progress` transition, call the overload that promotes; include `task_id` and `dispatched: bool` in response JSON.
  - New: `GET /api/sessions?issue_id=X` filter param (extend existing handler).

### `kernel/crates/gctrl-orch/` (new crate, minimal)
- `Cargo.toml`
- `src/lib.rs` — re-exports.
- `src/stub.rs` — `Orchestrator::tick()` that does one poll: list dispatchable tasks, for each insert a `sessions` row with status `active`, emit `orchestrator.claim` tracing span. No actual agent launch yet — this is scaffolding so the acceptance test can observe a session appearing.
- Wired into `gctrl-cli` daemon `serve` startup: tokio task calls `tick()` every 2s.

### `apps/gctrl-board/`
- `web/src/api/client.ts` — no change (existing `moveIssue` returns the extended body).
- `web/src/hooks/useSessions.ts` (new or extend) — poll `GET /api/sessions?issue_id=X` every 3s while a card is in `in_progress`.
- `web/src/components/IssueCard.tsx` — session-running indicator (spinner icon) when `issue.session_ids.length > 0`.

---

## Data Model Additions

```sql
-- tasks (new)
CREATE TABLE IF NOT EXISTS tasks (
    id                  VARCHAR PRIMARY KEY,      -- project-keyed: "<ISSUE_ID>.T<N>" e.g. "BACK-42.T1"
    issue_id            VARCHAR,                  -- FK to board_issues.id, nullable (Tasks can exist without Issues)
    project_key         VARCHAR NOT NULL,
    attempt_ordinal     INTEGER NOT NULL,         -- monotonic per issue_id; drives the T<N> suffix
    agent_kind          VARCHAR NOT NULL,         -- from WORKFLOW.md agent.runtime
    orchestrator_claim  VARCHAR NOT NULL DEFAULT 'Unclaimed',
                                                   -- Unclaimed | Claimed | Running | RetryQueued | Released
    attempt             INTEGER NOT NULL DEFAULT 0,
    created_at          VARCHAR NOT NULL,
    updated_at          VARCHAR NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES board_issues(id) ON DELETE SET NULL,
    UNIQUE (issue_id, attempt_ordinal)
);

-- sessions: link to task
ALTER TABLE sessions ADD COLUMN task_id VARCHAR;  -- nullable for backward compat
CREATE INDEX IF NOT EXISTS sessions_task_id_idx ON sessions(task_id);
```

### Task ID format

Project-keyed: `<ISSUE_ID>.T<N>` where `N = max(attempt_ordinal for issue_id) + 1`, starting at `1`. Examples: `BACK-42.T1`, `BACK-42.T2`. Readable in logs/URLs and aligns with the human-addressable issue IDs the board already uses. IDs are stable — never renumbered when earlier attempts are released.

### Promote-or-reuse rule

- If a **non-terminal** (`Unclaimed` / `Claimed` / `Running` / `RetryQueued`) Task already exists for the Issue, reuse it. Prevents duplicate dispatch when a user drags the same card twice in quick succession.
- If the latest Task for the Issue is **`Released`** (terminal for the claim cycle), promotion inserts a **new** row with `attempt_ordinal + 1`. Rationale: `Released` means "that attempt is done"; a fresh drag is a fresh intent, and a new Task gives the orchestrator a clean slate for claim/retry bookkeeping while preserving audit history of prior attempts.

---

## Test Pyramid — TDD Order

Red-green-refactor. Each step lands as its own commit on this branch.

### Tier 1: Domain unit (`gctrl-storage`)

**Red 1** — `tests/promote_issue_to_task.rs`:
- Given: an issue exists (`backlog`), no Task linked.
- When: `promote_issue_to_task("BACK-42", "claude-code")`.
- Then: exactly one `tasks` row exists with `issue_id=BACK-42`, `orchestrator_claim=Unclaimed`.

**Red 2** — same file:
- Given: Issue + a `Running` Task linked.
- When: `promote_issue_to_task` called again.
- Then: row count unchanged; returned Task has the existing id.

**Red 3** — `tests/update_board_issue_status_promotes.rs`:
- Given: Issue with `status=todo`.
- When: `update_board_issue_status(id, "in_progress", ...)`.
- Then: Issue status updated AND a Task row created with matching `issue_id`.

### Tier 2: HTTP integration (`gctrl-otel`)

**Red 4** — `tests/board_move_triggers_task.rs` (uses `tower::ServiceExt::oneshot`):
- POST `/api/board/issues/BACK-42/move` with `{status: "in_progress", ...}`.
- Assert response contains `task_id` and `dispatched: true`.
- Assert sqlite has the Task row.

### Tier 3: Orchestrator stub (`gctrl-orch`)

**Red 5** — `tests/tick_claims_dispatchable.rs`:
- Given: one `Unclaimed` Task row.
- When: `Orchestrator::tick()`.
- Then: `sessions` row exists with `task_id` set; Task's `orchestrator_claim=Claimed`.

### Tier 4: Acceptance (Playwright, `apps/gctrl-board/tests/acceptance/`)

**Red 6** — `session-trigger.spec.ts`:
- Seed: local kernel (`:memory:`) with one Issue `BACK-1` in `todo`, project with `WORKFLOW.md` specifying `agent.runtime: stub-runtime` (a no-op runtime so tests don't need Claude credentials).
- Drag card `issue-card-BACK-1` → drop on `column-in_progress`.
- Assert: within 5 s, `GET /api/sessions?issue_id=BACK-1` returns `length >= 1`.
- Assert: card shows running indicator (`data-testid="session-running-BACK-1"`).

The `stub-runtime` lives in a `#[cfg(test)]`-feature-gated adapter — used only by CI. Real `claude-code` runtime ships in a follow-up, behind a config flag.

### Tier 5: Soak (deferred to Slice 2+)

Soak tests wait until real compute is wired — no value running the stub under load.

---

## Acceptance Criteria (this slice only)

- [ ] `cargo test -p gctrl-storage` green including new promote tests.
- [ ] `cargo test -p gctrl-otel` green including HTTP integration test.
- [ ] `cargo test -p gctrl-orch` green.
- [ ] `pnpm --filter gctrl-board test` green.
- [ ] `pnpm --filter gctrl-board exec playwright test session-trigger` green locally.
- [ ] Manual: `gctrl serve` + open local board, drag an Issue to `in_progress`, see a session row in `gctl sessions list`.

---

## Resolved Decisions (for Slice 1)

1. **Task ID format** — **project-keyed `<ISSUE_ID>.T<N>`** (see [Task ID format](#task-id-format)). Readable in logs and URLs; aligns with existing human-addressable Issue IDs. Uniqueness is enforced by the `(issue_id, attempt_ordinal)` unique constraint.
2. **No `agent:` section in WORKFLOW.md** — **move succeeds, no Task created, `dispatched: false`** in the move response. Keeps `list tasks` free of never-dispatchable rows and makes the non-agentic workflow a first-class path for human-only projects.
3. **Released-state reuse** — **always create a new Task** when the latest Task for an Issue is `Released`. Preserves attempt history and gives the orchestrator a clean claim/retry slate for each fresh drag. Only non-terminal Tasks (`Unclaimed` / `Claimed` / `Running` / `RetryQueued`) are reused.
