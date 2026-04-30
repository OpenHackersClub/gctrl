# ADR: AgentRuntime × ComputeBackend Decoupling

**Status**: accepted
**Scope**: kernel orchestrator, scheduler, all current and future agent integrations
**Drives**: [`../kernel/runtime.md`](../kernel/runtime.md), [`../kernel/compute.md`](../kernel/compute.md)
**Extends**: [`adr-session-is-the-spine.md`](adr-session-is-the-spine.md)

## Context

Today's `AgentAdapter::launch(prompt, workspace, attempt)` in [`../../implementation/kernel/orchestrator.md`](../../implementation/kernel/orchestrator.md) treats *which agent* and *where it runs* as one concept. That worked when gctrl supported one runtime (`claude-code`) on one compute (`local-process`).

Two pressures break the conflation:

1. **Multiple agent CLIs.** Claude Code, Claude Agent SDK, Codex, OpenCode, and Aider each have different memory formats, IPC, sandbox stories, and OTel posture (catalogued in [`../../references/agent_orchestration.md`](../../references/agent_orchestration.md)). A team will run them in parallel — different runtimes for different roles, on the same shared kernel.
2. **Local + remote compute.** [`../session-trigger-from-board.md`](../session-trigger-from-board.md) Slices 2 and 3 ship `cf-containers`, e2b, and (eventually) a cloud orchestrator. The same `claude-code` runtime targets both. Without decoupling, every new compute target multiplies adapters.

Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents) post articulates the same split as "decoupling the brain from the hands": the *brain* (the harness loop) and the *hand* (the sandbox/execution environment) are independently swappable, and the *session* is a durable event log that lets either be rebooted without losing state.

[`../session-trigger-from-board.md § Compute × Runtime Split`](../session-trigger-from-board.md#compute--runtime-split) already drafts this for one app-flow. This ADR codifies it as a kernel-level invariant.

## Decision

The kernel exposes two independent ports:

1. **`AgentRuntime`** (the brain) — defines *which agent program runs* (`claude-code`, `codex`, `opencode`, `aider`, …). Owns the prompt invocation shape, the rollout-import logic, and the runtime-specific telemetry shim. See [`../kernel/runtime.md`](../kernel/runtime.md).

2. **`ComputeBackend`** (the hand) — defines *where it runs* (`local-process`, `cf-containers`, `e2b`, `ssh-remote`, `browser-tab`). Owns provisioning, egress policy, credential delivery, and failure-as-tool-error. See [`../kernel/compute.md`](../kernel/compute.md).

**Invariants:**

1. **Brain ≠ Hand.** No `AgentRuntime` implementation MAY assume a specific `ComputeBackend`; no `ComputeBackend` MAY assume a specific Runtime. Cross-product compatibility is the public contract; the matrix below is its closed form.
2. **Many brains × many hands.** A `ComputeBackend` instance MAY host more than one attached Runtime (one container, two agent processes). A single Runtime instance MAY drive more than one Compute handle (one harness, multiple sandboxes). Topologies are not constrained at the port level.
3. **Compute failure is a tool error.** A killed container, a quota'd e2b sandbox, or a dropped SSH connection MUST surface to the Orchestrator as `AgentExitAbnormal`. Sessions MUST NOT die because hands die — the existing retry path handles recovery.
4. **Sessions are recoverable from the event log alone.** A re-dispatch on a different `(runtime, compute)` pair MUST be possible if the previous attempt's SessionEvents are intact. This extends [`adr-session-is-the-spine.md`](adr-session-is-the-spine.md) — Session is the spine of *both* observability and recovery.
5. **Runtime selects, Compute provisions.** The Runtime declares the invocation (`command`, `env`, `stdin`, `workspace_mount`); the Compute executes it. Neither port performs the other's job.
6. **Egress is centralized.** All ComputeBackends MUST route external traffic through the kernel MITM proxy. Runtimes that ship their own proxy MUST chain through it.

## Compatibility Matrix

The supported `(runtime, compute)` pairings. New combinations require an entry here and a conformance test. `⚠ no inner sandbox` means the runtime ships no OS-level isolation of its own — gctrl's outer compute is the only boundary, so `local-process` is denied for those rows.

| Runtime ↓ \ Compute → | `local-process` | `cf-containers` | `e2b` | `ssh-remote` | `browser-tab` |
|---|---|---|---|---|---|
| `claude-code`       | ✓ today | ✓ Slice 2 | ✓ | ✓ | ✗ |
| `claude-agent-sdk`  | ✓ | ✓ | ✓ | ✓ | ✗ |
| `codex`             | ✓ | ✓ | ✓ | ✓ | ✗ |
| `opencode`          | ⚠ trusted Tasks only | ✓ (outer compute IS the sandbox) | ✓ | ✓ | ✗ |
| `aider`             | ⚠ trusted Tasks only | ✓ | ✓ | ✓ | ✗ |
| `custom`            | declared per-runtime | declared per-runtime | declared | declared | ✗ |

`browser-tab` is reserved for human-attached or browser-automation Tasks; no agent runtime currently targets it.

## Consequences

**Good**

1. **Orthogonal expansion.** Adding `codex` does not touch `cf-containers`. Adding `e2b` does not touch any runtime. The matrix grows additively.
2. **Heterogeneous teams.** A `reviewer-bot` Persona MAY run as `(claude-code, local-process)` for fast local review and `(codex, cf-containers)` for long-running CI review on the same Task type. Cost attribution and span shape are identical because the kernel normalizes through `import_rollout`.
3. **Recovery without re-running.** A crashed container surfaces as `AgentExitAbnormal`; the orchestrator retries — possibly on a different compute or a different runtime — without losing the session log.
4. **One credential boundary.** The vault-proxy credential pattern (deferred but specified) lives at the ComputeBackend layer once, not per-runtime.

**Cost**

1. **Two ports instead of one.** Implementations of `AgentRuntime` and `ComputeBackend` must be written and tested independently; cross-product conformance tests are required for each new entry in the matrix.
2. **`Task.context` carries both `runtime_kind` and `compute_kind`.** Analytics queries that filter by agent program MUST disambiguate against the `agent_kind` column; queries that filter by execution environment MUST filter `compute_kind`. The pair, not either alone, identifies a dispatch.
3. **Eligibility check is wider.** The Orchestrator MUST verify the `(runtime, compute)` pair against the matrix at dispatch eligibility. A Task with an unsupported pair MUST fail fast at dispatch time, not at launch.

## Non-decisions

1. This ADR does NOT decide whether to ship a kernel-hosted MCP proxy for vault-proxied credentials. That is `[deferred]` to a follow-up ADR; this ADR only declares the credential-boundary invariant (no long-lived secrets in the compute env).
2. Does NOT decide the per-runtime telemetry shim implementation (Claude Code hooks, OpenCode SSE translator). Those are runtime-level details captured in [`../kernel/runtime.md`](../kernel/runtime.md).
3. Does NOT mandate any specific compute backend for production. The matrix lists what is *supported*; what is *deployed* is a per-Task WORKFLOW.md decision.
4. Does NOT change the Orchestrator state machine or claim-state semantics ([`../kernel/orchestrator.md`](../kernel/orchestrator.md)). The dispatch step gains two ports; the state machine is unchanged.

## Trigger to Revisit

1. A `(runtime, compute)` pair appears in production deployment that cannot honestly map to one row of the matrix — implies the matrix is too coarse or a new dimension exists.
2. Three or more runtimes need the same compute-side helper (e.g. all of them want a credential-injection step). That helper SHOULD be lifted into the ComputeBackend port rather than re-implemented per Runtime.
3. A multi-machine claim coordinator becomes necessary — the "many hands" assumption changes from process-level to host-level and the failure-as-tool-error rule may need to evolve.

If two of the three trigger, revisit the decoupling shape explicitly rather than letting per-runtime workarounds accrete.
