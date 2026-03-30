# Orchestration — Implementation Details

Implementation details for the orchestration state machine defined in [specs/architecture/kernel/orchestrator.md](../../architecture/kernel/orchestrator.md). This file covers Rust crate structure, agent adapter wiring, and concrete configuration.

## Tech Stack Rationale

The Rust orchestrator MUST use the **tower + JoinSet + backon + tracing** stack. This stack is preferred because:

1. **tower** — Middleware composition (retries, timeouts, rate limiting, concurrency limits) mirrors Effect-TS Layer/Service composition. Tower `Service` trait is the Rust analog of Effect-TS services: request-in, response-out, with composable middleware. Reuses the same middleware patterns as the axum HTTP layer already in gctl.
2. **tokio::task::JoinSet** — Lightweight structured concurrency for managing multiple agent processes. Provides spawn + collect semantics without distributed computing overhead. Sufficient for local single-machine orchestration — we MUST NOT introduce distributed task queues (Temporal, Celery, etc.) until there is a proven need for multi-machine dispatch.
3. **backon** — Declarative retry/backoff strategies that compose cleanly. Avoids hand-rolling exponential backoff loops. Supports fixed, exponential, and custom backoff — matches the retry constants defined in this spec.
4. **tracing** — Structured, span-based observability that maps directly to OpenTelemetry. Every dispatch, retry, and reconciliation event becomes a tracing span, automatically exported via the existing `gctl-otel` pipeline.

This stack keeps orchestration **local-first and single-process**, consistent with gctl's design principles. It is the closest Rust analog to Effect-TS's composable service model (tower ≈ Layer, JoinSet ≈ Effect.fork, backon ≈ Schedule, tracing ≈ Effect.withSpan). Distributed orchestration (multi-machine, durable queues) is explicitly deferred — if needed in the future, tower middleware can be swapped to back a distributed dispatcher without changing the agent adapter trait or state machine logic.

---

## 1. Rust Crate: `gctl-orch` [deferred]

The Rust implementation mirrors the Lean 4 model. The transition function is a direct translation — any divergence is a bug.

### Crate Structure

```
kernel/crates/gctl-orch/
  src/
    lib.rs                   -- Public API
    state.rs                 -- ClaimState, Trigger, transition()
    run_attempt.rs           -- RunAttemptPhase, RunAttempt
    orchestrator.rs          -- Main loop: poll, reconcile, dispatch
    dispatch.rs              -- Candidate selection, eligibility, ordering
    retry.rs                 -- Backoff computation, timer scheduling
    workspace.rs             -- Workspace create/reuse/cleanup
    agent/
      mod.rs                 -- AgentKind trait
      claude_code.rs         -- Claude Code adapter
      aider.rs               -- Aider adapter
      custom.rs              -- Custom command adapter
    config.rs                -- WORKFLOW.md parsing (agent section)
  Cargo.toml
```

### State Machine (Rust)

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

### Agent Adapter Trait

```rust
/// Port: any agent that can execute a prompt in a workspace.
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    /// Human-readable agent kind name.
    fn kind(&self) -> &str;

    /// Launch the agent process. Returns a handle for monitoring.
    async fn launch(
        &self,
        prompt: &str,
        workspace: &Path,
        attempt: u32,
    ) -> Result<AgentHandle, AgentError>;
}

pub struct AgentHandle {
    pub pid: u32,
    pub kill: Box<dyn FnOnce() -> Result<(), std::io::Error> + Send>,
}
```

### Agent Kind Configuration

```yaml
# WORKFLOW.md front matter
agent:
  kind: claude-code          # or: aider, custom
  command: "claude"          # executable name or path
  args: ["--print", "--dangerously-skip-permissions"]
  prompt_flag: "--prompt"    # how to pass the rendered prompt
  max_turns: 5
  stall_timeout_ms: 300000
  max_concurrent_agents: 4
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in_progress: 3
    todo: 1
```

### Built-in Agent Adapters

| Kind | Command | Prompt Delivery | Notes |
|------|---------|----------------|-------|
| `claude-code` | `claude` | `--prompt` flag or stdin | Default. Supports `--print` for non-interactive. |
| `aider` | `aider` | `--message` flag | Requires repo context in workspace. |
| `custom` | user-defined | `prompt_flag` from config | Any executable that accepts a prompt and exits. |

### Dispatch Algorithm (Pseudocode)

```
for each candidate in sorted_eligible_issues:
    if global_slots_exhausted: break
    if per_state_slots_exhausted(candidate.state): continue
    if candidate in claimed or running: continue
    if candidate.state == "todo" and has_non_terminal_blockers(candidate): continue

    claim(candidate)
    workspace = prepare_workspace(candidate)
    prompt = render_prompt(candidate, attempt)
    run_hooks("before_run", workspace)
    handle = agent_adapter.launch(prompt, workspace, attempt)
    running[candidate.id] = RunEntry { handle, agent_kind, started_at, attempt }
```

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
    .gctl/
      run-log.jsonl                # append-only run attempt log
    <repo contents or working files>
```

Default workspace root: `~/.local/share/gctl/workspaces`.

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
gctl-orch
  ├── gctl-core       (ClaimState, Trigger, transition — shared types)
  ├── gctl-storage    (read issue/task state)
  ├── gctl-otel       (emit orchestration telemetry spans)
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
