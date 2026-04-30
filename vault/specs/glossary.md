# Glossary

Canonical definitions for gctrl domain terms. When terms are used in specs, they MUST carry these meanings. For Unix analogies and layer terminology, see `vault/specs/architecture/os.md`.

---

## Kernel Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **Task** | The kernel's unit of agent work. Created by agents via the Scheduler. Has a lifecycle (`pending → running → done/failed`). Normalized across all agent systems. | Kernel | Scheduler |
| **OrchTask** *(Rust impl detail)* | The orchestrator's per-attempt claim record in `kernel/crates/gctrl-core/src/types.rs`. Carries identity (id, issue_id, project_key), attempt ordinal, agent kind, and orchestrator claim state. **NOT the same as the Scheduler's Task** — the Scheduler primitive (full work-item with title/status/dependencies) is the canonical name and lives in `architecture/kernel/scheduler.md`. `OrchTask` is the transitional shape used by Slice 1 of session-trigger-from-board.md until the full Scheduler ships. | Kernel | `gctrl-core` / `gctrl-orch` |
| **Session** | The unit of agent execution — the gctrl analogue of a Unix process. Has execution state (`active → completed/failed/cancelled`). Each Session executes at most one Task. | Kernel | Telemetry |
| **Span** | An OpenTelemetry span — a single operation within a Session (LLM call, tool invocation, event marker). Stored in the `spans` table. | Kernel | Telemetry |
| **Trace** | A tree of related Spans sharing a `trace_id`. Typically one Trace per Session. | Kernel | Telemetry |
| **User** | An identity (human or agent persona) with a `user_id`. Every Session runs on behalf of a User. See `os.md` § 6. | Kernel | Storage |
| **Persona** | A configured agent identity with a fixed capability set. Like a Unix system account — defines *what* the agent may do. One LLM can run under multiple Personas. Configured in `WORKFLOW.md`. | Kernel | Orchestrator |
| **AgentKind** | The agent system/program: `claude-code`, `claude-agent-sdk`, `codex`, `opencode`, `aider`, `openai`, `custom`. Identifies *which software* is running, not who is running it (that is Persona) and not where it runs (that is ComputeKind). Tracked per Task. See `architecture/kernel/harness.md`. | Kernel | Scheduler |
| **AgentHarness** | The kernel port that defines *which agent program runs* — the brain. Each `AgentKind` has one Runtime implementation. Decoupled from `ComputeSubstrate`. See `architecture/kernel/harness.md`. | Kernel | Orchestrator |
| **ComputeSubstrate** | The kernel port that defines *where an agent runs* — the hand. Built-in: `local-process`, `cf-containers`, `e2b`, `ssh-remote`, `docker`, `browser-tab`. Decoupled from `AgentHarness`. See `architecture/kernel/compute.md`. | Kernel | Orchestrator |
| **ComputeKind** | The execution-environment identifier on a Task — companion of `AgentKind`. Together they fully identify a dispatch. See `architecture/kernel/compute.md`. | Kernel | Scheduler |
| **Invocation** | The Runtime-rendered description of how to execute the agent: command, env, stdin, workspace mount. Produced by `AgentHarness::render_invocation`, consumed by `ComputeSubstrate::launch`. | Kernel | `gctrl-orch` |
| **Slot** | A concurrency permit. The Orchestrator manages a fixed pool of Slots; each running Session holds one. Limits parallel agent work. See `orchestrator.md` § Concurrency. | Kernel | Orchestrator |
| **Prompt** | The rendered instruction text given to an agent for a Task. Stored in `prompt_versions` by content hash. Tasks reference it via `prompt_hash`. | Kernel | Storage |
| **Guardrail** | A policy that constrains Sessions — cost budgets, loop detection, command allowlists. The kernel analogue of `cgroups`/`ulimit`. | Kernel | Guardrails |
| **Alert** | A guardrail-triggered or human-triggered interrupt that changes Session behavior — pause, terminate, warn. The kernel analogue of Unix signals. | Kernel | Guardrails |
| **Driver** | A loadable kernel module connecting an external application (Linear, GitHub, Notion) to gctrl. Implements a kernel interface trait. The Unix loadable kernel module (LKM) analogy — loaded into the kernel, feature-gated, independently optional. NOT the same as "adapter." | Kernel | Per-driver crate |
| **Adapter** | An internal kernel implementation of a trait (e.g., DuckDB storage, OTel receiver). Used only in implementation specs. NOT the same as "driver." | Kernel (impl) | Per-adapter crate |
| **Kernel Interface** | A trait in `gctrl-core` that drivers or adapters implement (e.g., `SchedulerPort`, `BrowserPort`). The syscall interface analogy. | Kernel | `gctrl-core` |
| **Kernel IPC** | Cross-component communication via domain events, pipes (stdin/stdout), or HTTP sockets. How applications observe kernel events. | Kernel | Event Bus |

## Application Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **Issue** | A human-facing work item tracked by gctrl-board. Has a kanban lifecycle (`backlog → todo → in_progress → in_review → done`). Updated by the Tracker application component when Tasks/Sessions complete. NOT a kernel concept. | Application | gctrl-board (Tracker) |
| **Issue Key** | A formatted identifier like `BACK-42` — composed of `{PROJECT_KEY}-{COUNTER}`. Project key is from `board_projects.key`; counter auto-increments per project. | Application | gctrl-board |
| **Tracker** | An application component of gctrl-board that manages Issue lifecycle, dependency DAG, and auto-transitions. Subscribes to kernel IPC events. NOT a kernel primitive. | Application | gctrl-board |
| **Board** | A kanban view of Issues (human-managed) and Tasks (agent-managed, read-only). Configured per-project with columns and WIP limits. | Application | gctrl-board |
| **Eval Score** | A quality rating attached to a Session, Span, Task, Eval Case, or Eval Run — human-annotated, auto-computed, or judge-produced. Stored in the kernel-owned `scores` table; the same row carries scores from every lifecycle phase (dev, CI, staging, prod). | Application | Observe & Eval |
| **Metric** | A named scoring function registered in `eval_metrics`. Resolves to either an in-process evaluator (deterministic check) or a judge prompt (LLM-as-judge). The unit of metric-name continuity from dev → prod. | Application | Observe & Eval |
| **Judge** | An LLM-as-judge invocation produced by a metric of `kind='judge'`. Calls the kernel Model Router; the call itself is captured as Spans like any other generation. | Application | Observe & Eval |
| **Eval Run** | A grouping row in `eval_runs` that ties a batch of `Score`s together (one per `gctrl eval run` invocation or app-initiated batch). Carries suite name, baseline ref, git sha, env, model. | Application | Observe & Eval |
| **Eval Case** | A single `{ input, expected?, context? }` item belonging to a Dataset. Schema is intentionally permissive — apps may also pass cases inline without registering them. | Application | Observe & Eval |
| **Eval Dataset** | A named collection of Eval Cases. Required for harness mode and replayable baselines; not required for substrate-mode calls. | Application | Observe & Eval |
| **Eval Substrate** | The metrics, prompts, judges, and score store reachable via `POST /api/eval/*`. Applications drive their own loops and call into it. | Application | Observe & Eval |
| **Eval Harness** | The `gctrl eval run` runner that loads a suite, iterates cases, calls the substrate per case, and gates pass/fail. A built-in client of the substrate — no private path. | Application | Observe & Eval |

## Shell Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **CLI Dispatcher** | Parses `gctrl <noun> <verb>` arguments and routes to the correct handler. The shell itself — not the commands. | Shell | `gctrl-cli` |
| **HTTP API** | REST endpoints on `:4318` and SSE for live feeds. Mediates all programmatic access to the kernel. | Shell | `gctrl-otel` |
| **Query Engine** | Guardrailed DuckDB queries with structured output. Accessed via CLI or HTTP. | Shell | `gctrl-query` |

## Cross-Cutting Concepts

| Term | Definition | Notes |
|------|-----------|-------|
| **Native Application** | A stateful program built on gctrl (gctrl-board, Observe & Eval, Capacity Engine). Owns namespaced tables. | Like `vim`, `git` on Unix |
| **External Application** | A third-party tool connected to gctrl (Linear, Notion, Phoenix). Connected via a Driver (loadable kernel module). | Like hardware accessed via a kernel module |
| **Utility** | A stateless, single-purpose tool (`net fetch`, `browser goto`). Composes via stdin/stdout. No owned tables. | Like `curl`, `grep` on Unix |
| **Workspace** | An isolated directory for a Task. Persists across retries. Today, an implementation detail of the `local-process` ComputeSubstrate; under the runtime/compute split (see `architecture/kernel/compute.md`), each backend defines its own workspace mount semantics. | One workspace per Task |
| **Inner sandbox** | The OS-level isolation a Runtime ships with itself (Seatbelt for Claude Code, bubblewrap+seccomp for Codex, none for OpenCode/Aider). See the table in `architecture/kernel/harness.md`. | Distinct from outer compute |
| **Outer compute** | The OS-level isolation a `ComputeSubstrate` provides (process / container / VM / namespace). When the runtime has no inner sandbox, the outer compute is the only boundary — see `architecture/kernel/compute.md`. | Distinct from inner sandbox |
