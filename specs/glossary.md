# Glossary

Canonical definitions for gctl domain terms. When terms are used in specs, they MUST carry these meanings. For Unix analogies and layer terminology, see `specs/architecture/os.md`.

---

## Kernel Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **Task** | The kernel's unit of agent work. Created by agents via the Scheduler. Has a lifecycle (`pending → running → done/failed`). Normalized across all agent systems. | Kernel | Scheduler |
| **Session** | The unit of agent execution — the gctl analogue of a Unix process. Has execution state (`active → completed/failed/cancelled`). Each Session executes at most one Task. | Kernel | Telemetry |
| **Span** | An OpenTelemetry span — a single operation within a Session (LLM call, tool invocation, event marker). Stored in the `spans` table. | Kernel | Telemetry |
| **Trace** | A tree of related Spans sharing a `trace_id`. Typically one Trace per Session. | Kernel | Telemetry |
| **User** | An identity (human or agent persona) with a `user_id`. Every Session runs on behalf of a User. See `os.md` § 6. | Kernel | Storage |
| **Persona** | A configured agent identity with a fixed capability set. Like a Unix system account — defines *what* the agent may do. One LLM can run under multiple Personas. Configured in `WORKFLOW.md`. | Kernel | Orchestrator |
| **AgentKind** | The agent system/program: `claude-code`, `codex`, `aider`, `openai`, `custom`. Identifies *which software* is running, not who is running it (that is Persona). | Kernel | Scheduler |
| **Slot** | A concurrency permit. The Orchestrator manages a fixed pool of Slots; each running Session holds one. Limits parallel agent work. See `orchestrator.md` § Concurrency. | Kernel | Orchestrator |
| **Prompt** | The rendered instruction text given to an agent for a Task. Stored in `prompt_versions` by content hash. Tasks reference it via `prompt_hash`. | Kernel | Storage |
| **Guardrail** | A policy that constrains Sessions — cost budgets, loop detection, command allowlists. The kernel analogue of `cgroups`/`ulimit`. | Kernel | Guardrails |
| **Alert** | A guardrail-triggered or human-triggered interrupt that changes Session behavior — pause, terminate, warn. The kernel analogue of Unix signals. | Kernel | Guardrails |
| **Driver** | A kernel module connecting an external application (Linear, GitHub, Notion) to gctl. Implements a kernel interface trait. The Unix device driver analogy. NOT the same as "adapter." | Kernel | Per-driver crate |
| **Adapter** | An internal kernel implementation of a trait (e.g., DuckDB storage, OTel receiver). Used only in implementation specs. NOT the same as "driver." | Kernel (impl) | Per-adapter crate |
| **Kernel Interface** | A trait in `gctl-core` that drivers or adapters implement (e.g., `SchedulerPort`, `BrowserPort`). The syscall interface analogy. | Kernel | `gctl-core` |
| **Kernel IPC** | Cross-component communication via domain events, pipes (stdin/stdout), or HTTP sockets. How applications observe kernel events. | Kernel | Event Bus |

## Application Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **Issue** | A human-facing work item tracked by gctl-board. Has a kanban lifecycle (`backlog → todo → in_progress → in_review → done`). Updated by the Tracker application component when Tasks/Sessions complete. NOT a kernel concept. | Application | gctl-board (Tracker) |
| **Issue Key** | A formatted identifier like `BACK-42` — composed of `{PROJECT_KEY}-{COUNTER}`. Project key is from `board_projects.key`; counter auto-increments per project. | Application | gctl-board |
| **Tracker** | An application component of gctl-board that manages Issue lifecycle, dependency DAG, and auto-transitions. Subscribes to kernel IPC events. NOT a kernel primitive. | Application | gctl-board |
| **Board** | A kanban view of Issues (human-managed) and Tasks (agent-managed, read-only). Configured per-project with columns and WIP limits. | Application | gctl-board |
| **Eval Score** | A quality rating attached to a Session, Span, or Task — human-annotated or auto-computed. Stored in `eval_scores` (Observe & Eval application). | Application | Observe & Eval |

## Shell Concepts

| Term | Definition | Layer | Owner |
|------|-----------|-------|-------|
| **CLI Dispatcher** | Parses `gctl <noun> <verb>` arguments and routes to the correct handler. The shell itself — not the commands. | Shell | `gctl-cli` |
| **HTTP API** | REST endpoints on `:4318` and SSE for live feeds. Mediates all programmatic access to the kernel. | Shell | `gctl-otel` |
| **Query Engine** | Guardrailed DuckDB queries with structured output. Accessed via CLI or HTTP. | Shell | `gctl-query` |

## Cross-Cutting Concepts

| Term | Definition | Notes |
|------|-----------|-------|
| **Native Application** | A stateful program built on gctl (gctl-board, Observe & Eval, Capacity Engine). Owns namespaced tables. | Like `vim`, `git` on Unix |
| **External Application** | A third-party tool installed on gctl (Linear, Notion, Phoenix). Connected via a Driver. | Like an app accessed via device driver |
| **Utility** | A stateless, single-purpose tool (`net fetch`, `browser goto`). Composes via stdin/stdout. No owned tables. | Like `curl`, `grep` on Unix |
| **Workspace** | An isolated directory for a Task. Persists across retries. Managed by the Orchestrator. | One workspace per Task |
