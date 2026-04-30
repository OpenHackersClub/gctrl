# Compute Backend

The **ComputeSubstrate** is the kernel port that defines *where* an agent runs — local process, Cloudflare Container, e2b sandbox, SSH-attached host, or browser tab. It is decoupled from the **AgentHarness** (which agent runs); see [harness.md](harness.md). A Session is the cross-product of one Runtime and one Compute.

> Status: **[deferred]**. The port is currently sketched inline in [`../session-trigger-from-board.md`](../session-trigger-from-board.md). This file is the canonical kernel-architecture spec for the Compute port; the existing `AgentAdapter` in `kernel/crates/gctrl-orch/src/agent/` will be split into Runtime + Compute as part of the [Slice 2 scope](../session-trigger-from-board.md#deployment-phasing).

---

## 1. Compute Port

```rust
#[async_trait]
pub trait ComputeSubstrate: Send + Sync {
    /// Stable compute identifier — e.g. "local-process", "cf-containers".
    fn kind(&self) -> ComputeKind;

    /// Provision execution resources for an Invocation. MAY pull a container
    /// image, allocate a VM slot, attach to a remote host, or fork a process.
    async fn launch(&self, invocation: Invocation, spec: ComputeSpec)
        -> Result<ComputeHandle, ComputeError>;
}

pub struct ComputeHandle {
    pub id: String,                              // pid, container_id, e2b sandbox_id, …
    pub kill: Box<dyn FnOnce() -> Result<(), ComputeError> + Send>,
    pub wait: Box<dyn Future<Output = ComputeExit> + Send>,
}

pub struct ComputeSpec {
    pub kind: ComputeKind,
    pub image: Option<String>,                   // container image, e2b template, etc.
    pub cpu_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub egress: EgressPolicy,                    // see § Network Egress
    pub credentials: CredentialDelivery,         // see § Credentials
}
```

The ComputeSubstrate MUST NOT decide *what* runs inside — that is the Runtime's job via `Invocation`. The ComputeSubstrate only allocates the execution environment, wires stdin/stdout/stderr, enforces egress policy, and reports exit.

---

## 2. Built-in Backends

| ComputeKind | Where it runs | Durable? | Status |
|---|---|---|---|
| `local-process` | `tokio::process::Child` on the gctrl daemon host | Workspace dir persists; process does not | Wired today |
| `cf-containers` | Cloudflare Container, ephemeral | No (re-provision on retry) | [deferred] |
| `e2b` | e2b cloud sandbox VM | No (re-provision on retry) | [deferred] |
| `ssh-remote` | SSH-attached remote host | Workspace persists on the host | [deferred] |
| `docker` | Local Docker / Podman container | Workspace via volume mount | [deferred] |
| `browser-tab` | CDP-attached Chromium tab via [browser.md](browser.md) | Tab persists across attaches | [deferred] |

The default and only currently-implemented backend is `local-process`; new backends MUST be feature-gated and SHOULD ship behind an explicit WORKFLOW.md opt-in until proven on real Tasks.

---

## 3. Failure-as-Tool-Error

A killed container, a closed SSH connection, a quota'd e2b sandbox — any compute failure MUST surface to the Orchestrator as `AgentExitAbnormal`, never as a kernel error. This mirrors the principle that "containers are cattle": the Orchestrator's existing retry path handles the recovery (see [orchestrator.md § Retry and Backoff](orchestrator.md#retry-and-backoff)).

> **Formal verification.** This rule is mechanically checked in [`kernel/specs-lean4/KernelSpec/Substrate.lean`](../../../../kernel/specs-lean4/KernelSpec/Substrate.lean): `Substrate.exit_lands_in_retryQueued` proves every `ComputeExit` (`clean | error _ | crashed | killed | networkLost`) lands in `RetryQueued` from `Running` — the orchestrator never gets stuck because of how a compute died.

**Rules:**

1. ComputeSubstrate `wait` futures MUST resolve to `ComputeExit` even on crashes — never panic, never propagate kernel-level errors.
2. The `kill` closure MUST be idempotent — calling it on an already-dead compute MUST succeed silently.
3. Re-dispatch on a different `(runtime, compute)` pair MUST be possible if the previous attempt's SessionEvents are intact in the session log.
4. The ComputeSubstrate MUST NOT persist state that the kernel does not also know about. Anything load-bearing for recovery MUST be in the kernel session log.

---

## 4. Sandbox Composition — Outer Compute vs Inner Sandbox

ComputeSubstrate provides the *outer* sandbox (process / container / VM / namespace boundary). The Runtime provides its own *inner* sandbox if it has one (Seatbelt for Claude Code, bubblewrap+seccomp for Codex, none for OpenCode and Aider). The combined posture is what gctrl actually deploys.

| Runtime | Inner OS sandbox | Inner network sandbox | gctrl outer additions |
|---|---|---|---|
| `claude-code` | Seatbelt / bubblewrap | domain allowlist | MITM proxy spans, guardrails |
| `claude-agent-sdk` | configurable | configurable | route through gctrl MITM |
| `codex` | Seatbelt / bubblewrap / seccomp | `codex-network-proxy` | compose: route the inner proxy egress through gctrl MITM |
| `opencode` | **none** | **none** | gctrl MUST sandbox via outer compute (`compute ≠ local-process`) and MITM |
| `aider` | **none** | **none** | gctrl MUST sandbox via outer compute and MITM |
| `custom` | unspecified | unspecified | declared per-runtime in WORKFLOW.md |

**Rule:** A `(runtime, compute)` pair where the runtime has *no* inner sandbox MUST NOT use `compute = local-process` for untrusted prompts or Tasks created by external Issues. The Orchestrator MUST refuse such dispatches at eligibility check (see [orchestrator.md § Dispatch Eligibility](orchestrator.md#dispatch-eligibility)).

---

## 5. Network Egress

All egress from a ComputeSubstrate MUST traverse the kernel MITM proxy ([`../../implementation/kernel/components.md`](../../implementation/kernel/components.md) — `gctrl-proxy`). This is non-negotiable: every external call MUST be observable as a span and MUST be policy-checkable by Guardrails.

```rust
pub enum EgressPolicy {
    /// Allow only domains on the Task's WORKFLOW.md allowlist.
    Allowlist(Vec<String>),
    /// Allow all egress; useful for trusted internal Tasks.
    Open,
    /// Deny all egress; the Runtime must use bundled resources only.
    Closed,
}
```

The compute MUST inject `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` and the kernel CA cert at provision time. Runtimes that ship their own proxy (Codex's `codex-network-proxy`) MUST be configured to chain through the kernel MITM rather than open their own egress.

---

## 6. Credentials — Resource-Bundled vs Vault-Proxied

Two patterns, both supported:

1. **Resource-bundled credentials** — secrets used during provision (e.g. `git clone` with a PAT, then unset). The credential is consumed by setup and never reaches the running Runtime. Example: cloning a private repo into the workspace before launching the agent.

2. **Vault-proxied credentials** — `[deferred]`. Secrets stored in the kernel; the Runtime calls a kernel-hosted MCP proxy at runtime; the proxy injects credentials at egress; the secret never enters the compute environment.

```rust
pub enum CredentialDelivery {
    /// One-time use during provision. Erased before Runtime launches.
    ResourceBundled { setup: Vec<SetupStep> },

    /// Runtime calls kernel MCP proxy; secrets never leave the kernel.
    VaultProxied { mcp_endpoint: Url },
}
```

The ComputeSubstrate MUST NOT pass long-lived secrets via environment variables to the Runtime process. Drivers (LKMs) that hold credentials (`driver-github`, `driver-linear`) MUST expose either resource-bundled setup steps or a vault-proxied MCP endpoint — never raw env vars.

---

## 7. Concurrency — Per-Compute Slots

Each ComputeSubstrate has its own concurrency profile. `local-process` is bounded by laptop CPU; `cf-containers` is cheap and parallel; `ssh-remote` is bounded by the remote box's load.

The Orchestrator MUST enforce per-compute slot limits in addition to global and per-state limits (see [orchestrator.md § Concurrency Control](orchestrator.md#concurrency-control)):

```toml
[orchestrator.compute_slots]
local-process  = 4
cf-containers  = 20
e2b            = 6
ssh-remote     = 2
browser-tab    = 8
```

When a per-compute slot is exhausted, eligible Tasks targeting that compute MUST stay `Unclaimed` until a slot frees — they MUST NOT be silently re-routed to a different compute, since the Runtime/Compute pairing is part of the dispatch contract.

---

## 8. Configuration

ComputeSubstrates are selected per-Task via `WORKFLOW.md` frontmatter:

```yaml
agent:
  runtime: claude-code
  compute: cf-containers
  compute_config:
    image: "gctrl/claude-code:latest"
    cpu_ms: 30000
    memory_mb: 2048
    egress: "allowlist"
    egress_allowlist:
      - "api.anthropic.com"
      - "github.com"
      - "raw.githubusercontent.com"
```

`compute_config` is opaque to the kernel and passed verbatim to the ComputeSubstrate's `launch` method. Validation lives in the backend, not the orchestrator.

---

## 9. Observability

Every ComputeSubstrate operation MUST emit kernel telemetry events:

| Event | Fields |
|---|---|
| `compute.provision.start` | `compute_kind`, `compute_id`, `task_id`, `runtime_kind`, `image` |
| `compute.provision.ready` | `compute_id`, `provision_ms` |
| `compute.exit` | `compute_id`, `exit_code`, `duration_ms`, `cpu_ms`, `peak_memory_mb` |
| `compute.kill` | `compute_id`, `reason`, `forced` |

These are observed by the Orchestrator and surfaced in the existing `orchestrator.dispatch` / `orchestrator.agent_exit` events (which gain `compute_kind` and `compute_id` fields — see [orchestrator.md § Observability](orchestrator.md#observability)).

---

## 10. Extending — Adding a New Backend

1. Define a `ComputeKind` variant in `gctrl-core`.
2. Implement the `ComputeSubstrate` trait in a new feature-gated crate: `kernel/crates/gctrl-compute-<kind>/`.
3. Implement `launch` — provision resources, wire the Invocation, return a `ComputeHandle`.
4. Implement `kill` and `wait` — both MUST honor the failure-as-tool-error rule.
5. Add a row to the **Built-in Backends** table in this file and to the [compatibility matrix](../apps/adr-runtime-compute-decoupling.md#compatibility-matrix).
6. Add per-compute concurrency limits to `orchestrator.compute_slots` defaults.
7. Write a conformance test that exercises provision → launch → kill → wait against a representative Runtime (`claude-code` is the reference).

---

## 11. Non-Goals

1. **No multi-machine claim coordination.** Slice 3 of [`../session-trigger-from-board.md`](../session-trigger-from-board.md) deploys one orchestrator instance — multi-machine claim coordination is explicitly deferred until proven need.
2. **No compute-to-compute composition.** A ComputeSubstrate MUST NOT call into another ComputeSubstrate. Cross-compute work goes through the Scheduler (sub-Task with a different `compute` configured).
3. **No host-OS escape hatches.** ComputeSubstrates MUST NOT expose ways to read host filesystem, signal host processes, or bypass the egress policy. The compute is the boundary; if a Task needs more, it gets a new compute.
