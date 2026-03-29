# Template: Orchestration State Machine

Defines the kernel-level orchestration state machine for dispatching, tracking, and recovering agent work on tasks and issues. Inspired by [OpenAI Symphony SPEC.md §7](https://github.com/openai/symphony/blob/main/SPEC.md#7-orchestration-state-machine), adapted for gctl's agent-agnostic, local-first model.

**Key difference from Symphony**: gctl's orchestrator is agent-agnostic — it dispatches to any agent runtime, not just one vendor. It lives in the **kernel layer** and is exposed via CLI.

For implementation details (Lean 4 formal verification, Rust crate structure, adapter wiring), see [specs/implementation/orchestration.md](../../implementation/orchestration.md).

---

## 1. Design Goals

1. Provide a single authoritative orchestrator state for dispatch, retries, and reconciliation.
2. Work with any coding agent that accepts a prompt and produces artifacts (commits, PRs, comments).
3. Live in the kernel — applications observe orchestration state but MUST NOT mutate it directly.
4. Expose all state transitions via CLI for human and agent use.
5. Support restart recovery without requiring persistent orchestrator state (tracker + filesystem are the source of truth).
6. Enforce bounded concurrency and per-state limits.
7. State machine properties (determinism, reachability, liveness) MUST be formally verified before implementation.

## 2. Orchestration States (Kernel Claim States)

> **Source of truth:** [`specs/formal/KernelSpec/Orchestrator.lean`](../../formal/KernelSpec/Orchestrator.lean)
> States, transitions, and all 6 required properties are machine-checked in Lean 4 (16 theorems, zero `sorry`).

These are the orchestrator's **internal claim states**, distinct from the kanban lifecycle in [issue-lifecycle.md](issue-lifecycle.md). An issue's kanban status and its orchestration claim state are independent dimensions.

States: `Unclaimed` → `Claimed` → `Running` → `Released`, with `Paused` and `RetryQueued` as intermediate states. See the Lean source for the complete `step` function.

### Important Nuances

1. A successful agent exit does not mean the issue is done. The orchestrator schedules a continuation check to verify the issue is still active.
2. After abnormal exit, the orchestrator schedules an exponential-backoff retry.
3. `Released` is not terminal for the issue — only for the current claim cycle (`full_cycle` theorem).

### Verified Properties

All properties are machine-checked — see `KernelSpec/Orchestrator.lean`:

1. **No duplicate dispatch** — `dispatch_only_from_unclaimed`
2. **Reachability** — `all_reachable`
3. **Liveness** — `claimed_always_progresses`, `retryQueued_always_progresses`
4. **Determinism** — `deterministic`
5. **Terminal convergence** — `released_reachable_from_any`
6. **Pause/resume integrity** — `paused_integrity`, `paused_not_dispatchable`

## 3. Run Attempt Lifecycle

> **Source of truth:** [`specs/formal/KernelSpec/RunAttempt.lean`](../../formal/KernelSpec/RunAttempt.lean)
> Phases, transitions, and the `always_forward` termination proof are machine-checked (8 theorems).

Each dispatch is a linear pipeline: `PreparingWorkspace` → `BuildingPrompt` → `LaunchingAgent` → `StreamingWork` → `Finishing` → `Succeeded`|`Failed`. Every phase can fail early. `StreamingWork` can also exit to `TimedOut` or `Canceled`.

The `always_forward` theorem proves every transition strictly increases phase ordering, guaranteeing termination.

## 4. Transition Triggers

| Trigger | What Happens |
|---------|-------------|
| **Poll Tick** | Reconcile running issues, validate config, fetch candidates, sort by priority, dispatch until slots exhausted. |
| **Agent Exit (Normal)** | Remove from running set, record telemetry, schedule continuation check. |
| **Agent Exit (Abnormal)** | Remove from running set, record error telemetry, schedule exponential-backoff retry. |
| **Retry Timer Fired** | Re-fetch candidates, re-dispatch if still eligible, else release claim. |
| **Guardrail Suspend** | Guardrails engine emits suspend signal → running session transitions to `Paused`. |
| **Human Pause** | Operator issues `gctl orchestrate pause` → running session transitions to `Paused`. |
| **Human Resume** | Operator issues `gctl orchestrate resume` → `Paused` session transitions back to `Running`. |
| **Reconciliation** | Detect stalls (elapsed > timeout → kill + retry). Refresh tracker state (terminal → release, active → update snapshot, fetch failure → keep running). Paused sessions are skipped — they are not stale. |

### Tick Sequence

1. **Reconcile** — check all running issues against tracker state.
2. **Validate** — verify configuration is loadable.
3. **Fetch candidates** — query active issues from tracker.
4. **Sort** — priority ascending, then `created_at` oldest first, then identifier.
5. **Dispatch** — claim and launch agents until concurrency slots are exhausted.

## 5. Agent Dispatch (Agent-Agnostic)

The orchestrator MUST NOT assume a specific agent. Agent kind is resolved from configuration. Any executable that accepts a prompt (via flag, stdin, or file) and exits with a status code is a valid agent.

### Dispatch Eligibility

> **Source of truth:** [`specs/formal/KernelSpec/DispatchEligibility.lean`](../../formal/KernelSpec/DispatchEligibility.lean)
> 7-condition conjunction verified: satisfiable (`eligible_exists`), each condition independently necessary, terminal/paused/claimed states correctly blocked.

A task is dispatch-eligible only if **all** conditions hold. See the Lean `Context` structure and `isEligible` predicate for the formal model.

### Dispatch Ordering

1. Priority ascending (lower number = higher priority; null sorts last).
2. `created_at` oldest first.
3. Identifier lexicographic tie-breaker.

## 6. Retry and Backoff

### Continuation Retry (Normal Exit)

- Fixed short delay.
- Purpose: re-check if issue is still active and needs another agent session.
- If re-dispatched, the continuation prompt SHOULD be shorter than the initial prompt.

### Failure Retry (Abnormal Exit)

- Exponential backoff with configurable cap.
- Each retry cancels any existing timer for the same issue before scheduling.

### Retry Limits

- Continuation retries: bounded by max turns configuration.
- Failure retries: bounded by max failure retries configuration. After exhaustion, claim is released.

## 7. Concurrency Control

### Global Limit

Total running agents MUST NOT exceed the configured maximum.

### Per-State Limit

Each kanban state MAY have its own concurrency cap. States without explicit limits fall back to the global maximum.

### Per-User Limit

Each user (persona) MAY have its own concurrency cap, configured in WORKFLOW.md or guardrails config. Per-user limits are enforced after the global and per-state limits — all three must pass for dispatch to proceed.

```toml
[orchestrator]
max_sessions_per_user.agent = 2        # applies to all agent personas
max_sessions_per_user.reviewer-bot = 1 # override for a specific persona
```

### Blocker Rule

Issues in `todo` state MUST NOT be dispatched if any blocker is non-terminal.

## 8. Workspace Management

### Layout

Each issue gets an isolated workspace directory. Workspaces persist across runs for the same issue. Successful runs do NOT auto-delete workspaces.

### Hooks

| Hook | When | Failure behavior |
|------|------|-----------------|
| `after_create` | Workspace directory first created | Abort creation, fail attempt |
| `before_run` | Before each agent launch | Abort attempt, schedule retry |
| `after_run` | After each agent exit | Log warning, continue |
| `before_remove` | Before workspace deletion | Log warning, continue |

### Terminal Cleanup

- On startup: fetch terminal issues from tracker, remove their workspace directories.
- On reconciliation: if a running issue transitions to terminal, kill agent and clean workspace.

## 9. Idempotency and Recovery

1. The orchestrator serializes all state mutations — no concurrent dispatch of the same issue.
2. `Claimed` and `Running` checks are required before launching any agent.
3. Reconciliation runs **before** dispatch on every tick.
4. Restart recovery is **tracker-driven + filesystem-driven**: scan workspaces on startup, cross-reference with tracker state, and resume or clean up.
5. No persistent orchestrator database required — state is reconstructed from the tracker and workspace filesystem.

## 10. Observability

The orchestrator MUST emit structured telemetry for every state transition:

| Event | Fields |
|-------|--------|
| `orchestrator.claim` | `issue_id`, `user_id`, `agent_kind`, `attempt` |
| `orchestrator.dispatch` | `issue_id`, `user_id`, `agent_kind`, `workspace` |
| `orchestrator.agent_exit` | `issue_id`, `exit_code`, `duration_ms` |
| `orchestrator.retry_scheduled` | `issue_id`, `attempt`, `delay_ms`, `reason` |
| `orchestrator.released` | `issue_id`, `reason` |
| `orchestrator.reconciliation` | `running_count`, `stalled_count`, `terminal_count` |

## 11. CLI Surface

The orchestrator is exposed as kernel CLI commands:

```sh
# Start the orchestration loop
gctl orchestrate start
gctl orchestrate start --daemon

# Inspect state
gctl orchestrate status
gctl orchestrate list
gctl orchestrate list --state running
gctl orchestrate inspect BACK-42

# Manual control
gctl orchestrate dispatch BACK-42
gctl orchestrate pause   BACK-42   # SIGSTOP — suspend, await human review
gctl orchestrate resume  BACK-42   # SIGCONT — approve continuation
gctl orchestrate cancel  BACK-42   # SIGTERM — graceful stop
gctl orchestrate retry   BACK-42
gctl orchestrate release BACK-42

# Configuration
gctl orchestrate config
gctl orchestrate config --validate
```

## 12. Kernel Placement

The orchestrator is a **kernel primitive**, not an application. It depends on:

- **Scheduler** — timer management for poll ticks and retry delays.
- **Storage** — reading issue/task state (read-only).
- **Telemetry** — emitting orchestration events.

Applications observe orchestration state through the shell (HTTP API or CLI queries) but MUST NOT bypass the kernel to mutate orchestrator state.
