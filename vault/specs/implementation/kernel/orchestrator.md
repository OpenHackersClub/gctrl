# Orchestration — Implementation Details

Implementation details for the orchestration state machine defined in [vault/specs/architecture/kernel/orchestrator.md](../../architecture/kernel/orchestrator.md). This file covers Rust crate structure, harness/substrate wiring (per [harness.md](../../architecture/kernel/harness.md) + [compute.md](../../architecture/kernel/compute.md)), and concrete configuration.

## Tech Stack Rationale

The Rust orchestrator MUST use the **tower + JoinSet + backon + tracing** stack. This stack is preferred because:

1. **tower** — Middleware composition (retries, timeouts, rate limiting, concurrency limits) mirrors Effect-TS Layer/Service composition. Tower `Service` trait is the Rust analog of Effect-TS services: request-in, response-out, with composable middleware. Reuses the same middleware patterns as the axum HTTP layer already in gctrl.
2. **tokio::task::JoinSet** — Lightweight structured concurrency for managing multiple agent processes. Provides spawn + collect semantics without distributed computing overhead. Sufficient for local single-machine orchestration — we MUST NOT introduce distributed task queues (Temporal, Celery, etc.) until there is a proven need for multi-machine dispatch.
3. **backon** — Declarative retry/backoff strategies that compose cleanly. Avoids hand-rolling exponential backoff loops. Supports fixed, exponential, and custom backoff — matches the retry constants defined in this spec.
4. **tracing** — Structured, span-based observability that maps directly to OpenTelemetry. Every dispatch, retry, and reconciliation event becomes a tracing span, automatically exported via the existing `gctrl-otel` pipeline.

This stack keeps orchestration **local-first and single-process**, consistent with gctrl's design principles. It is the closest Rust analog to Effect-TS's composable service model (tower ≈ Layer, JoinSet ≈ Effect.fork, backon ≈ Schedule, tracing ≈ Effect.withSpan). Distributed orchestration (multi-machine, durable queues) is explicitly deferred — if needed in the future, tower middleware can be swapped to back a distributed dispatcher without changing the agent adapter trait or state machine logic.

---

## 1. Rust Crate: `gctrl-orch` [deferred]

The Rust implementation mirrors the Lean 4 model. The transition function is a direct translation — any divergence is a bug.

### Crate Structure

```
kernel/crates/gctrl-orch/
  src/
    lib.rs                   -- Public API
    state.rs                 -- ClaimState, Trigger, transition()
    run_attempt.rs           -- RunAttemptPhase, RunAttempt
    orchestrator.rs          -- Main loop: poll, reconcile, dispatch
    dispatch.rs              -- Candidate selection, eligibility, ordering
    retry.rs                 -- Backoff computation, timer scheduling
    workspace.rs             -- Default workspace (local-process substrate)
    harness/                 -- AgentHarness impls (the "brain")
      mod.rs                 -- AgentHarness trait re-export from gctrl-core
      claude_code.rs         -- claude-code harness
      claude_agent_sdk.rs    -- claude-agent-sdk harness
      codex.rs               -- codex harness
      opencode.rs            -- opencode harness
      aider.rs               -- aider harness
      custom.rs              -- custom-executable harness
    compute/                 -- ComputeSubstrate impls (the "hand")
      mod.rs                 -- ComputeSubstrate trait re-export from gctrl-core
      local_process.rs       -- local-process substrate (default)
      cf_containers.rs       -- cf-containers substrate (Slice 2)
      ssh_remote.rs          -- ssh-remote substrate (Slice 2+)
    config.rs                -- WORKFLOW.md parsing (agent section)
  Cargo.toml
```

The trait definitions for `AgentHarness` and `ComputeSubstrate` live in `gctrl-core` (per Crate Ownership rule #1 in [`principles.md`](../../principles.md)); each `harness/` and `compute/` submodule contains one impl per `AgentKind` / `ComputeKind` variant.

### State Machine (Rust)

> **Single source of truth:** [`kernel/specs-lean4/KernelSpec/Orchestrator.lean`](../../../../kernel/specs-lean4/KernelSpec/Orchestrator.lean). The Rust translation below is a spec for the `gctrl-orch` crate to implement; it MUST match the Lean `step` function exactly. If the Lean module is updated, this Rust translation MUST be regenerated — divergence is a bug, not a deliberate decision. The conformance tests in §5 verify equivalence.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimState {
    Unclaimed,
    Claimed,
    Running,
    RetryQueued,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    DispatchEligible,
    AgentLaunched,
    AgentExitNormal,
    AgentExitAbnormal,
    ReconciliationTerminal,
    RetryDispatch,
    NoLongerEligible,
    MaxRetries,
    DispatchFailed,
    ReEligibleNextTick,
}

/// Deterministic transition — mirrors Lean 4 definition exactly.
pub fn transition(state: ClaimState, trigger: Trigger) -> Option<ClaimState> {
    use ClaimState::*;
    use Trigger::*;
    match (state, trigger) {
        (Unclaimed,   DispatchEligible)       => Some(Claimed),
        (Claimed,     AgentLaunched)          => Some(Running),
        (Claimed,     DispatchFailed)         => Some(Released),
        (Running,     AgentExitNormal)        => Some(RetryQueued),
        (Running,     AgentExitAbnormal)      => Some(RetryQueued),
        (Running,     ReconciliationTerminal) => Some(Released),
        (RetryQueued, RetryDispatch)          => Some(Running),
        (RetryQueued, NoLongerEligible)       => Some(Released),
        (RetryQueued, MaxRetries)             => Some(Released),
        (Released,    ReEligibleNextTick)     => Some(Unclaimed),
        _ => None,
    }
}
```

### Dispatch Ports

The orchestrator depends on two traits — `AgentHarness` and `ComputeSubstrate` — defined in `gctrl-core`. The canonical specs are [`harness.md`](../../architecture/kernel/harness.md) and [`compute.md`](../../architecture/kernel/compute.md); they MUST NOT be restated here. Brief Rust shape (this file is the implementation plan, not the trait spec):

```rust
// gctrl-core::ports
#[async_trait] pub trait AgentHarness: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn render_invocation(&self, prompt: &str, workspace: &Path) -> Invocation;
    async fn import_rollout(&self, session_id: SessionId, source: RolloutSource)
        -> Result<(), RolloutError>;
}

#[async_trait] pub trait ComputeSubstrate: Send + Sync {
    fn kind(&self) -> ComputeKind;
    async fn launch(&self, invocation: Invocation, spec: ComputeSpec)
        -> Result<ComputeHandle, ComputeError>;
}
```

`Invocation`, `ComputeHandle`, `ComputeSpec`, and the failure-as-tool-error rule are in `harness.md` / `compute.md`. The orchestrator obtains both impls from a registry at startup and never references concrete types.

### WORKFLOW.md Configuration (agent section)

```yaml
# WORKFLOW.md front matter — see harness.md § 7 + compute.md § 8 for full schema.
agent:
  runtime: claude-code             # AgentKind — see harness.md § 3 for built-ins
  compute: local-process           # ComputeKind — see compute.md § 2 for built-ins
  args: ["--print", "--dangerously-skip-permissions"]
  prompt_flag: "--prompt"
  max_turns: 5
  stall_timeout_ms: 300000
  max_concurrent_agents: 4
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in_progress: 3
    todo: 1
  # compute-specific (forwarded to ComputeSubstrate::launch as ComputeSpec):
  compute_config:
    image: "gctrl/claude-code:latest"   # cf-containers / docker only
    cpu_ms: 30000
    memory_mb: 2048
```

The `(runtime, compute)` pair MUST be one of the supported combinations in the [compatibility matrix](../../architecture/apps/adr-runtime-compute-decoupling.md#compatibility-matrix); orchestrator MUST refuse dispatch on unsupported pairs at eligibility check.

### Dispatch Algorithm (Pseudocode)

```
for each candidate in sorted_eligible_tasks:
    if global_slots_exhausted: break
    if per_state_slots_exhausted(candidate.state): continue
    if per_compute_slots_exhausted(candidate.compute_kind): continue
    if candidate in claimed or running: continue
    if candidate.state == "pending" and has_non_terminal_blockers(candidate): continue
    if not pair_supported(candidate.agent_kind, candidate.compute_kind): fail_fast; continue

    claim(candidate)
    workspace = prepare_workspace(candidate)             // owned by local-process substrate
    prompt    = render_prompt(candidate, attempt)
    run_hooks("before_run", workspace)

    harness   = harness_registry.get(candidate.agent_kind)
    substrate = substrate_registry.get(candidate.compute_kind)
    invocation = harness.render_invocation(prompt, workspace)
    handle    = substrate.launch(invocation, compute_spec_from(candidate)).await

    running[candidate.id] = RunEntry { handle, agent_kind, compute_kind, started_at, attempt }
```

Compute failure (container crash, SSH drop, e2b quota) MUST surface from `substrate.launch().await` or `handle.wait` as `ComputeExit::{crashed | killed | networkLost}` and be mapped to `Trigger::AgentExitAbnormal` for the existing retry path. See [`KernelSpec/Substrate.lean`](../../../../kernel/specs-lean4/KernelSpec/Substrate.lean) `exit_lands_in_retryQueued`.

### Retry Constants

| Retry Type | Delay | Formula |
|-----------|-------|---------|
| Continuation (normal exit) | Fixed | `1000ms` |
| Failure (abnormal exit) | Exponential | `min(10000 * 2^(attempt - 1), max_retry_backoff_ms)` |
| Default max backoff | — | `300000ms` (5 minutes) |
| Default max failure retries | — | `3` |

### Concurrency Accounting

```rust
fn available_global_slots(&self) -> usize {
    self.config.max_concurrent_agents.saturating_sub(self.running.len())
}

fn available_state_slots(&self, state: &str) -> usize {
    let limit = self.config.max_concurrent_agents_by_state
        .get(state)
        .copied()
        .unwrap_or(self.config.max_concurrent_agents);
    let running = self.running.values()
        .filter(|r| r.tracked_state == state)
        .count();
    limit.saturating_sub(running)
}
```

### Workspace Layout

```
<workspace_root>/
  <sanitized_issue_identifier>/    # e.g., BACK-42/
    .gctrl/
      run-log.jsonl                # append-only run attempt log
    <repo contents or working files>
```

Default workspace root: `~/.local/share/gctrl/workspaces`.

## 3. Observability Events

```rust
#[derive(Debug, Serialize)]
#[serde(tag = "event")]
pub enum OrchEvent {
    #[serde(rename = "orchestrator.claim")]
    Claim { issue_id: String, agent_kind: String, attempt: u32 },
    #[serde(rename = "orchestrator.dispatch")]
    Dispatch { issue_id: String, agent_kind: String, pid: u32, workspace: String },
    #[serde(rename = "orchestrator.agent_exit")]
    AgentExit { issue_id: String, exit_code: i32, duration_ms: u64, tokens_used: Option<u64> },
    #[serde(rename = "orchestrator.retry_scheduled")]
    RetryScheduled { issue_id: String, attempt: u32, delay_ms: u64, reason: String },
    #[serde(rename = "orchestrator.released")]
    Released { issue_id: String, reason: String },
    #[serde(rename = "orchestrator.reconciliation")]
    Reconciliation { running_count: usize, stalled_count: usize, terminal_count: usize },
}
```

## 4. Crate Dependencies

```
gctrl-orch
  ├── gctrl-core       (ClaimState, Trigger, transition — shared types)
  ├── gctrl-storage    (read issue/task state)
  ├── gctrl-otel       (emit orchestration telemetry spans)
  ├── tower           (Service trait, middleware: concurrency limit, timeout, retry)
  ├── tokio           (async runtime, timers, process spawning, JoinSet)
  ├── backon          (declarative retry/backoff strategies)
  ├── tracing         (structured spans, OpenTelemetry-compatible instrumentation)
  ├── serde / serde_json (config parsing, event serialization)
  └── thiserror       (error types)
```

## 5. Testing Strategy

### Unit Tests

1. **Transition function exhaustiveness** — test every valid (state, trigger) pair matches Lean 4 output.
2. **Transition function rejects invalid pairs** — test that invalid combinations return `None`.
3. **Backoff computation** — test exponential formula, cap, and edge cases (attempt 0, overflow).
4. **Candidate sorting** — test priority, created_at, identifier ordering.
5. **Eligibility rules** — test blocker rule, concurrency limits, state filtering.

### Integration Tests

1. **Poll loop** — start orchestrator with in-memory storage, insert issues, verify dispatch sequence.
2. **Retry cycle** — simulate agent failure, verify backoff scheduling and re-dispatch.
3. **Reconciliation** — change issue to terminal state mid-run, verify agent killed and claim released.
4. **Workspace lifecycle** — verify create, reuse, and cleanup across multiple run attempts.

### State Machine Conformance

The Rust `transition()` function MUST be tested exhaustively — every `(State, Trigger)` combination checked against expected output.
