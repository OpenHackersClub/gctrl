# Agent Runtime

The **AgentRuntime** is the kernel port that defines *which agent program* runs — Claude Code, Claude Agent SDK, Codex CLI, OpenCode, Aider, or a custom executable. It is decoupled from the **ComputeSubstrate** (where it runs); see [compute.md](compute.md). A Session is the cross-product of one Runtime and one Compute.

> Status: **[deferred]**. The port is currently sketched inline in [`../session-trigger-from-board.md`](../session-trigger-from-board.md). This file is the canonical kernel-architecture spec for the Runtime port; the existing `AgentAdapter` in `kernel/crates/gctrl-orch/src/agent/` will be split into Runtime + Compute as part of the [Slice 2 scope](../session-trigger-from-board.md#deployment-phasing).

---

## 1. Why Decouple Runtime from Compute

Today's `AgentAdapter::launch(prompt, workspace, attempt)` in [`../../implementation/kernel/orchestrator.md`](../../implementation/kernel/orchestrator.md) conflates two concerns:

1. **Which agent program is running?** (the *brain* — Claude Code, Codex, OpenCode)
2. **Where is it running?** (the *hand* — local process, Cloudflare Container, e2b, SSH)

These vary independently. The same `claude-code` runtime ships against a `local-process` compute on a developer laptop and a `cf-containers` compute in production. The same `cf-containers` compute hosts both `claude-code` and `codex` runtimes for parallel team workflows. Conflating them locks each runtime to the compute it shipped with first.

See [adr-runtime-compute-decoupling.md](../apps/adr-runtime-compute-decoupling.md) for the architectural decision and invariants.

> **Formal verification.** The runtime/compute orthogonality invariant is mechanically checked in [`kernel/specs-lean4/KernelSpec/Substrate.lean`](../../../../kernel/specs-lean4/KernelSpec/Substrate.lean): `Substrate.orthogonality` proves the Orchestrator state machine never branches on `(runtime, compute)` — changing either component preserves every transition.

---

## 2. Runtime Port

```rust
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Stable runtime identifier — matches AgentKind enum.
    fn kind(&self) -> AgentKind;

    /// Render the executable invocation for a rendered prompt + workspace mount.
    /// MUST NOT execute the runtime — only describe how to.
    fn render_invocation(&self, prompt: &str, workspace: &Path) -> Invocation;

    /// Map runtime-native session output (rollouts, JSONL, SQLite) to gctrl
    /// SessionEvents at completion. Enables harness recovery and analytics
    /// across runtimes.
    async fn import_rollout(&self, session_id: SessionId, source: RolloutSource)
        -> Result<(), RolloutError>;
}

pub struct Invocation {
    pub command: Vec<String>,        // e.g. ["claude", "--print", "--prompt", ...]
    pub env: BTreeMap<String, String>,
    pub stdin: Option<String>,       // for runtimes that pipe the prompt
    pub workspace_mount: PathBuf,    // local path the compute mounts/copies
}
```

The Runtime MUST NOT spawn the process — that is the ComputeSubstrate's job. The Runtime only declares *what command to run*, *what env to set*, and *how to read back what happened*.

`AgentKind` is defined in [domain-model.md § 2 Task](../domain-model.md#task-specs-only) and tracked in the Scheduler. See [scheduler.md § Tasks](scheduler.md#tasks) for how `agent_kind` is normalized at task creation.

---

## 3. Built-in Runtimes

| AgentKind | Repo | Language | Status |
|---|---|---|---|
| `claude-code` | (closed-source) | Node.js | Wired today via `AgentAdapter::ClaudeCode` |
| `claude-agent-sdk` | `anthropics/claude-agent-sdk` | Multi | [deferred] |
| `codex` | `github.com/openai/codex` | Rust | [deferred] |
| `opencode` | `github.com/sst/opencode` | TypeScript/Bun | [deferred] |
| `aider` | `github.com/Aider-AI/aider` | Python | Wired today via `AgentAdapter::Aider` |
| `custom` | user-defined executable | any | Wired today via `AgentAdapter::Custom` |

For the per-runtime architectural details (process model, sandbox, IPC, OTel), see [`../../references/agent_orchestration.md`](../../references/agent_orchestration.md). The tables below summarize only what gctrl's kernel must know about each.

---

## 4. Telemetry Ingest per Runtime

Every Runtime MUST surface its execution as OTel spans on the kernel `/v1/traces` endpoint. Each runtime takes a different path because their native telemetry stories diverge.

| Runtime | Native telemetry source | gctrl ingest path |
|---|---|---|
| `claude-code` | `PostToolUse` / `InstructionsLoaded` hooks (no native OTel in the CLI) | hook-shim script → `POST /v1/traces` |
| `claude-agent-sdk` | Native OTel (Agent SDK ships OTLP) | direct OTLP → `/v1/traces` |
| `codex` | Native OTLP via `codex-otel` crate (HTTP + gRPC, mTLS supported) | direct OTLP → `/v1/traces` |
| `opencode` | `/event` SSE stream (Hono server, no OTel) | SSE consumer + translator → `/v1/traces` |
| `aider` | None | wrap stdout; emit synthetic spans on tool-call boundaries |
| `custom` | unspecified | declared per-runtime in WORKFLOW.md `telemetry` block |

Runtimes that emit native OTLP MUST be configured to point at the kernel's OTLP endpoint at provision time — credentials and endpoint are injected by the ComputeSubstrate, never compiled in.

---

## 5. Inner Sandbox per Runtime

Each runtime ships its own OS-level sandbox (or none). gctrl's ComputeSubstrate provides the *outer* sandbox; the Runtime's own sandbox is *inner*. This distinction matters for security policy: runtimes with no inner sandbox MUST run inside a ComputeSubstrate that provides isolation.

| Runtime | Inner OS sandbox | Inner network sandbox |
|---|---|---|
| `claude-code` | Apple Seatbelt / bubblewrap | domain allowlist + HTTPS proxy |
| `claude-agent-sdk` | Configurable per host | Configurable |
| `codex` | Seatbelt / bubblewrap / seccomp / Windows Sandbox | `codex-network-proxy` (loopback HTTP/SOCKS5) |
| `opencode` | None | None |
| `aider` | None | None |
| `custom` | unspecified | unspecified |

**Rule:** A `(runtime, compute)` pair where the runtime has no inner sandbox MUST NOT be deployed to `compute = local-process` for untrusted Tasks. The compatibility matrix in [adr-runtime-compute-decoupling.md](../apps/adr-runtime-compute-decoupling.md) encodes the supported pairings.

---

## 6. Memory and Session Format per Runtime

Each runtime persists conversation history in its own format. The Runtime's `import_rollout` method normalizes these into kernel SessionEvents so analytics, audit, and harness recovery work uniformly across runtimes.

| Runtime | Native session format | Importer reads |
|---|---|---|
| `claude-code` | Markdown — `~/.claude/projects/<hash>/memory/MEMORY.md` + tool-call hooks log | hook log + MEMORY.md |
| `claude-agent-sdk` | SDK-defined event log | SDK rollout API |
| `codex` | JSONL rollouts under `$CODEX_SQLITE_HOME` + SQLite state | rollout JSONL |
| `opencode` | SQLite (Drizzle) at `~/.local/share/opencode/opencode.db` | SQLite rows |
| `aider` | Git commit log + `.aider.chat.history.md` | commit log |
| `custom` | unspecified | declared per-runtime |

Importers MUST be idempotent — re-importing the same rollout MUST NOT produce duplicate SessionEvents. The kernel uses content-addressed deduplication via `content_hash` (see [domain-model.md](../domain-model.md)).

---

## 7. Configuration

Runtimes are selected per-Task via `WORKFLOW.md` frontmatter and surfaced on `Task.context`:

```yaml
agent:
  runtime: claude-code              # AgentKind
  compute: local-process            # ComputeKind — see compute.md
  args: ["--print", "--dangerously-skip-permissions"]
  prompt_flag: "--prompt"
  max_turns: 5
  stall_timeout_ms: 300000
```

The `runtime` and `compute` fields are independent — any pairing in the [compatibility matrix](../apps/adr-runtime-compute-decoupling.md#compatibility-matrix) is permitted. Defaults: `runtime = claude-code`, `compute = local-process`.

---

## 8. Persona, Runtime, and Compute

A **Persona** (see [`../../team/personas.md`](../../team/personas.md)) declares *who* is acting — capability bundle, prompt prefix, cost limits. The Persona MAY declare a *preferred* `(runtime, compute)` pair but MUST NOT lock to one. The same `reviewer-bot` Persona MAY run as `(claude-code, local-process)` for a quick local review and `(codex, cf-containers)` for a long-running CI review — both attribute cost to `reviewer-bot` and emit identically-shaped spans because the kernel normalizes through `import_rollout`.

```toml
[persona.reviewer-bot]
kind = "agent"
preferred = { runtime = "claude-code", compute = "local-process" }
allowed = [
  { runtime = "claude-code", compute = "*" },
  { runtime = "codex",       compute = "cf-containers" }
]
```

---

## 9. Extending — Adding a New Runtime

1. Define an `AgentKind` variant in `gctrl-core` (see [domain-model.md](../domain-model.md)).
2. Implement the `AgentRuntime` trait in a new module under `kernel/crates/gctrl-orch/src/agent/<runtime>.rs`.
3. Implement `render_invocation` — keep it pure, no I/O.
4. Implement `import_rollout` — deduplicate via `content_hash`.
5. Add a row to the **Telemetry Ingest** and **Inner Sandbox** tables in this file.
6. Add the runtime to the [compatibility matrix](../apps/adr-runtime-compute-decoupling.md#compatibility-matrix) with explicit supported `compute` columns.
7. Write a conformance test that runs the runtime against `compute = local-process` and asserts a complete SessionEvent log on the kernel side.

---

## 10. Non-Goals

1. **No model registry.** `AgentRuntime` identifies the *agent program*, not the model it calls. Model selection lives in `Task.context.model` (see [scheduler.md § Context Field](scheduler.md#context-field--agent-system-metadata)).
2. **No runtime-to-runtime direct calls.** Cross-runtime composition (e.g. Claude Code calling Codex as a tool) MUST go through the kernel — initially via the Scheduler (sub-Task spawn), eventually via the kernel-hosted MCP proxy `[deferred]`.
3. **No runtime-specific orchestrator state.** The Orchestrator state machine in [orchestrator.md](orchestrator.md) is runtime-agnostic and MUST stay so. Runtime-specific concerns (memory format, hook locations, sandbox flags) belong in this file and the `AgentRuntime` trait — never in the orchestrator.
