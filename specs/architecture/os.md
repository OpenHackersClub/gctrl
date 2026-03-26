# Unix Architecture — Layers, Execution Model, and Extension Points

gctl is modeled after Unix. This document covers two complementary views:

1. **Layer structure** — what belongs in each architectural layer (Kernel, Shell, Apps, Utilities, Drivers, Skills) and how to extend each layer.
2. **Execution model** — how agent work is scheduled, who runs it, and how identity works in a world where humans and agents are first-class actors.

For the high-level diagram and internal code architecture, see [README.md](README.md). For implementation details (crates, packages, code patterns), see [../implementation/components.md](../implementation/components.md).

---

## Terminology

gctl uses **Unix terminology** as the primary architectural language. Some terms overlap with hexagonal architecture (ports & adapters) — this glossary disambiguates.

| Term | Meaning | Unix Analogy | NOT to be confused with |
|------|---------|-------------|------------------------|
| **Kernel** | Core primitives (Telemetry, Storage, Guardrails, Orchestrator) | Linux kernel | — |
| **Shell** | CLI dispatcher, HTTP API, Query Engine | bash / zsh | — |
| **Native Application** | Stateful program built on gctl (gctl-board, Observe & Eval) | `vim`, `git` | — |
| **External Application** | Third-party tool installed on gctl (Linear, Plane, Notion, Phoenix) | External app accessed via device driver | "Adapter" (which means something else) |
| **Driver** | Kernel module connecting an external app (`driver-linear`, `driver-github`) | Device driver (`/dev/sda`) | "Adapter" in hexagonal architecture |
| **Kernel Interface** | Trait in `gctl-core` that drivers implement (`TrackerPort`, `ObservabilityExportPort`) | Driver interface / syscall interface | "Port" as a network port |
| **Kernel IPC** | Cross-app communication (event bus, pipes, sockets) | Unix IPC (pipes, signals, sockets) | — |
| **Adapter** | Internal kernel implementation of a trait (DuckDB storage, OTel receiver) — used only in [implementation specs](../implementation/components.md) | — | "Driver" (which connects external apps) |

**Rule:** In architecture specs and user-facing docs, use **driver** for external app connectors and **kernel interface** for the traits they implement. Reserve **adapter** for implementation-level discussion of internal kernel code only.

---

## Layer Overview

```mermaid
flowchart TB
  subgraph Skills["CLAUDE CODE SKILLS (.claude/commands/)"]
    AuditSpecs["/audit-specs"]
    ReviewSpecs["/review-specs"]
    StatusSkill["/status"]
    TraceSkill["/trace"]
    CustomSkill["/your-skill"]
  end

  subgraph ExtApps["EXTERNAL APPLICATIONS (installed, all optional)"]
    Linear["Linear"]
    Plane["Plane"]
    Notion["Notion"]
    Obsidian["Obsidian"]
    Phoenix["Arize Phoenix"]
  end

  subgraph Apps["NATIVE APPLICATIONS (stateful, optional)"]
    Board["gctl-board\n(kanban)"]
    Eval["Observe & Eval\n(scoring, analytics)"]
    Capacity["Capacity Engine\n(forecasting)"]
  end

  subgraph Utils["UTILITIES (single-purpose, optional)"]
    NetFetch["net fetch"]
    NetCrawl["net crawl"]
    NetCompact["net compact"]
    BrowserGoto["browser goto"]
  end

  subgraph Shell["SHELL (dispatcher)"]
    CLI["CLI Dispatcher\n(clap)"]
    HTTP["HTTP API\n(:4318, axum)"]
    Query["Query Engine\n(DuckDB SQL)"]
  end

  subgraph IPC["KERNEL IPC (cross-app communication)"]
    EventBus["Event Bus"]
    Pipes["Pipes (stdin/stdout)"]
    Sockets["Sockets (HTTP API)"]
  end

  subgraph Kernel["KERNEL (small, always present)"]
    Telemetry["Telemetry\n(OTel receiver)"]
    Storage["Storage\n(DuckDB)"]
    Guardrails["Guardrails\n(policy engine)"]
    Orchestrator["Orchestrator\n(dispatch + retry)"]
  end

  subgraph KernelExt["KERNEL EXTENSIONS (feature-gated)"]
    Scheduler["Scheduler"]
    Network["Network Control"]
    Browser["Browser Control"]
    Sync["Cloud Sync"]
  end

  Skills -->|"invoke"| CLI
  ExtApps -.->|"drivers\n(kernel interfaces)"| IPC
  Apps -->|"Shell APIs"| Shell
  Apps ---|"events"| IPC
  Utils --> Shell
  Shell --> Kernel
  IPC --> Kernel
  KernelExt --> Kernel
```

Dependencies flow **inward** — Shell depends on Kernel, Applications and Utilities depend on Shell, Adapters implement Kernel ports. Nothing in an inner layer knows about an outer layer.

---

## 1. Kernel — Mechanisms, Not Policy

The kernel provides small, focused primitives. It is agent-agnostic, application-agnostic, and use-case-agnostic. A solo developer running `gctl serve` gets a working system with just the kernel — no applications, no adapters, no configuration.

### Core Primitives (always present)

| Primitive | What It Does | Unix Analogy |
|-----------|-------------|--------------|
| **Telemetry** | OTLP span ingestion, session tracking, cost attribution | `/dev/log` — the system logging facility |
| **Storage** | Embedded DuckDB, schema migrations, retention policies | Filesystem — the shared data layer |
| **Guardrails** | Policy engine (cost limits, loop detection, command allowlists) | `ulimit` / `seccomp` — resource and security constraints |
| **Orchestrator** | Agent dispatch, retry with backoff, reconciliation | `init` / process manager — lifecycle management |

### Kernel Extensions (feature-gated, optional)

| Extension | What It Does | Unix Analogy |
|-----------|-------------|--------------|
| **Scheduler** | Deferred and recurring tasks via port/adapter pattern | `cron` / `at` |
| **Network Control** | MITM proxy, domain allowlists, traffic logging | `iptables` / packet filter |
| **Browser Control** | CDP daemon, persistent Chromium, tab management | Device driver for a display |
| **Cloud Sync** | R2 Parquet export, device-partitioned sync | `rsync` / NFS mount |

#### Scheduler — External Schedule Support

The scheduler is a kernel primitive for deferred and recurring task execution. It is defined as a **port** with **platform-specific adapters** — the kernel defines *what* to schedule; adapters decide *how* on a given platform. This means the OS supports external scheduling: launchd on macOS, Durable Object Alarms on Cloudflare Workers, or in-process timers for local development.

```mermaid
graph LR
    Port["Scheduler (port)"]
    DO["Durable Object Alarm<br/>(Cloudflare Workers)"]
    Automator["macOS Automator<br/>/ launchd"]
    InProc["In-process timers<br/>(local daemon)"]

    Port --> DO
    Port --> Automator
    Port --> InProc
```

| Platform | Adapter | Durable? |
|----------|---------|----------|
| **Cloudflare Workers** | Durable Object Alarm | Yes — persists across restarts |
| **macOS** | launchd / Automator | Yes — OS-managed scheduling |
| **Local daemon** | In-process timers | No — lost on daemon restart |

**Design constraints:**

1. The scheduler port lives in the domain — no platform dependencies.
2. Adapters live behind feature flags or in separate modules.
3. The in-process adapter is the default and requires no external setup.
4. Task payloads are serializable — they describe *what* to run, not *how*.
5. Durable adapters persist schedules across restarts. The in-process adapter does not — applications MUST handle re-registration on startup if durability is needed.

### What does NOT belong in the kernel

- Business logic about what "good" looks like (that is application policy)
- Knowledge of any specific application's tables or domain types
- Direct references to external tools (Linear, GitHub, Obsidian)
- UI rendering or formatting (that is the shell or application layer)

### Extending the kernel

Add a new kernel primitive or extension when:

1. The capability is **agent-agnostic and application-agnostic** — any application could benefit from it.
2. It provides a **mechanism**, not a policy — it does not encode opinions about workflows.
3. It needs **direct access to storage or low-level system resources** (network sockets, process spawning).

To add a kernel extension:

1. Create a new Rust crate: `crates/gctl-{name}/`
2. Define the port trait in `gctl-core` (e.g., `trait Scheduler`)
3. Implement the adapter in the new crate
4. Feature-gate it in `gctl-cli/Cargo.toml` so it is opt-in
5. The new primitive MUST NOT know about any application

---

## 2. Shell — Dispatcher, Not Commands

The shell mediates **all** access to the kernel. It is the dispatcher — it parses input and routes to the right handler. The shell itself contains no business logic and no domain knowledge.

### Shell Components

| Component | What It Does | Unix Analogy |
|-----------|-------------|--------------|
| **CLI Dispatcher** | Parses `gctl <noun> <verb>` args, routes to command handlers | `bash` — the interpreter, not the commands |
| **HTTP API** | REST endpoints on `:4318`, SSE for live feeds | Network sockets / IPC |
| **Query Engine** | Guardrailed DuckDB queries, structured output | `awk` / `sed` for structured data |

### What belongs in the shell

- Argument parsing and validation
- HTTP route registration and request/response handling
- Output formatting (`--format json`, `--format table`)
- Authentication, rate limiting, caching (HTTP layer)
- Routing a request to the correct kernel primitive or application handler

### What does NOT belong in the shell

- Business logic (that is the application or kernel layer)
- Direct DuckDB queries beyond dispatching to the query engine
- Knowledge of external tools or adapters

### How the shell dispatches

```mermaid
flowchart LR
  Agent["Agent or Human"] -->|"gctl sessions --format json"| CLI
  Agent -->|"GET /api/sessions"| HTTP["HTTP API"]
  CLI --> Router["Route to handler"]
  HTTP --> Router
  Router --> Kernel["Kernel: Storage.query()"]
  Kernel --> Output["JSON / Table / CSV"]
```

CLI commands and HTTP endpoints are **not** part of the shell — they are applications and utilities that register themselves with the shell dispatcher. The shell just routes.

### Extending the shell

You rarely need to extend the shell itself. Instead, you register new commands or routes:

- **New CLI subcommand**: Add a file in `gctl-cli/src/commands/`, register in `mod.rs`
- **New HTTP route**: Mount under `/api/{app}/*` in the axum router

---

## 3. Applications — Stateful Domain Programs

Applications are larger, stateful programs that orchestrate kernel primitives through the shell to deliver domain-specific features. They own their table namespaces and may have their own domain model.

### Shipped Applications

| Application | Tables Owned | Kernel Primitives Used | Runtime |
|-------------|-------------|----------------------|---------|
| **gctl-board** | `board_issues`, `board_tasks` | Storage, Telemetry (session-issue linking), Orchestrator | Effect-TS |
| **Observe & Eval** | `eval_scores`, `eval_prompts` | Telemetry, Storage, Query Engine | Rust (compiled into binary) |
| **Capacity Engine** | `capacity_*` | Storage, Telemetry, Query Engine | Rust (compiled into binary) |

### What makes something an application (not a utility)

- It **owns state** — it has its own namespaced tables in DuckDB
- It **orchestrates multiple kernel primitives** — e.g., board reads from Telemetry and writes to Storage
- It has **domain logic** — state machines, validation rules, business rules
- It may have **its own domain model** — e.g., board has Issue, Task, DependencyGraph

### Application rules

1. **Table namespacing**: All tables MUST use `{app}_*` prefixes (`board_issues`, `eval_scores`)
2. **Kernel access via shell**: Applications access kernel primitives through CLI or HTTP API — not by importing kernel crates directly (except Rust apps compiled into the binary)
3. **Cross-app isolation**: Apps MUST NOT join across each other's tables. Cross-app data flows through kernel-level events
4. **Optional by default**: Every application MUST be independently disableable. A developer using gctl only for telemetry MUST NOT see board commands

### Extending with a new application

```mermaid
flowchart TB
  A1["1. Define domain model\n(types, state machines, rules)"]
  A2["2. Declare storage tables\nCREATE TABLE IF NOT EXISTS myapp_*"]
  A3["3. Register CLI subcommands\ngctl myapp <verb>"]
  A4["4. Mount HTTP routes\n/api/myapp/*"]
  A5["5. Subscribe to kernel events\n(span ingested, session ended)"]
  A6["6. Declare sync prefixes\nanalytics/myapp/, knowledge/myapp/"]
  A1 --> A2 --> A3 --> A4 --> A5 --> A6
```

**Rust applications** are compiled into the `gctl` binary as feature-gated crates. They have direct access to `DuckDbStore` and register axum routes on the shared router.

**TypeScript applications** (like gctl-board) run as sidecar processes or are proxied through the Rust daemon. They communicate via the shell (HTTP API or CLI subprocess calls).

---

## 4. Utilities — Small, Single-Purpose Tools

Utilities are small tools that do one thing well and compose via stdin/stdout where practical. They are the `grep`, `curl`, `wget` of gctl.

### Shipped Utilities

| Utility | What It Does | Unix Analogy | Composes With |
|---------|-------------|--------------|---------------|
| `gctl net fetch <url>` | Fetch URL, convert to markdown | `curl` | Pipe to `gctl eval score` |
| `gctl net crawl <url>` | Crawl site, extract readable content | `wget -r` | Output feeds `net compact` |
| `gctl net compact <domain>` | Compact pages into LLM-ready context | `tar` / `cat` | Produces stdin-ready output |
| `gctl net list` | List crawled domains | `ls` | — |
| `gctl net show <domain>` | Show crawled content | `cat` | — |
| `gctl browser goto <url>` | Navigate browser to URL | headless Chrome | — |
| `gctl browser snapshot` | Capture page screenshot/DOM | `screencapture` | — |

### What makes something a utility (not an application)

- It is **stateless or minimally stateful** — it may cache to the filesystem but does not own DuckDB tables
- It does **one thing** — fetch, crawl, compact, snapshot
- It **composes** — accepts stdin, produces stdout, works in pipelines
- It has **no domain model** — no state machines, no business rules

### Utility rules

1. **One verb per command**: `gctl net fetch` fetches. `gctl net compact` compacts. No combined super-commands.
2. **Stdin/stdout where practical**: Output goes to stdout; metadata/errors go to stderr
3. **`--format json`**: Every utility that produces structured output MUST support JSON output
4. **No kernel coupling**: Utilities MAY use kernel primitives (e.g., net fetch logs to traffic table) but MUST NOT require the kernel to function for their core purpose

### Extending with a new utility

1. Create a Rust crate: `crates/gctl-{name}/` (or add to an existing utility crate if related)
2. Implement the core logic as a library (testable without CLI)
3. Register CLI subcommands in `gctl-cli/src/commands/`
4. Support `--format json` for structured output
5. Accept stdin and produce stdout where it makes sense

---

## 5. External Applications & Drivers — Installed Apps on the OS

Linear, Plane, Notion, Obsidian, Arize Phoenix, Langfuse, SigNoz — these are **external applications installed on gctl**, not mere connectors. Like applications on Unix, they have their own state and logic. Each connects through a **driver** — a kernel module that implements a kernel interface trait, translating between the external app's API and gctl's internal event/data model. This is the Unix device driver analogy: the kernel defines the interface; the driver implements it for a specific external system.

> **Terminology note:** gctl uses **"driver"** (not "adapter") for external app connectors to avoid confusion with hexagonal architecture adapters, which are internal kernel implementations (DuckDB storage, OTel receiver, etc.). See [README.md § Hexagonal Architecture](README.md#hexagonal-architecture-kernel--shell-only) for the distinction.

### The OS Metaphor

In Unix, applications do not talk to each other directly. They communicate through OS primitives: pipes, sockets, signals, shared files. gctl follows the same model:

```mermaid
flowchart LR
  subgraph Installed["Installed Applications"]
    Linear["Linear"]
    Plane["Plane"]
    Board["gctl-board"]
    Eval["Observe & Eval"]
  end

  subgraph IPC["Kernel IPC"]
    Events["Event Bus<br/>(domain events)"]
    Pipes["Pipes<br/>(stdin/stdout)"]
    Sockets["Sockets<br/>(HTTP API)"]
  end

  Linear ---|"driver"| Events
  Plane ---|"driver"| Events
  Board --- Events
  Eval --- Events
  Board --- Sockets
```

Native apps (gctl-board, Observe & Eval) and external apps (Linear, Plane, Notion) are **peers** on the OS. Neither talks directly to the other — all cross-app data flows through kernel IPC.

### IPC Mechanisms

| Mechanism | Unix Analogy | gctl Implementation | Example |
|-----------|-------------|---------------------|---------|
| **Event Bus** | Signals / named pipes | Domain events (`SessionEnded`, `IssueCreated`) | Telemetry emits `SessionEnded` → Eval auto-scores → Phoenix driver exports |
| **Pipes** | stdin/stdout | CLI output piped between commands | `gctl sessions --format json \| gctl analytics cost` |
| **Sockets** | Unix sockets / TCP | HTTP API endpoints | Driver polls `/api/sessions` or receives webhook callbacks |

### Kernel Interfaces for External Apps

| Kernel Interface | What It Defines | Drivers | Installed Apps |
|-----------------|----------------|---------|----------------|
| `TrackerPort` | Bidirectional issue/task sync | `driver-linear`, `driver-github`, `driver-notion` | Linear, Plane, GitHub Issues, Notion |
| `ObservabilityExportPort` | Export traces/evals/scores | `driver-phoenix`, `driver-langfuse`, `driver-signoz` | Arize Phoenix, Langfuse, SigNoz |
| `KnowledgeSourcePort` | Mount external knowledge bases | `driver-obsidian` | Obsidian |

### Driver Rules

1. **Implement a kernel interface**: Every driver MUST implement a trait defined in `gctl-core`
2. **No direct table access**: Drivers MUST go through the kernel interface trait, never write to DuckDB directly
3. **Independently optional**: Each driver is a separate feature-gated crate
4. **Bidirectional where needed**: Pull from external API into gctl; push gctl events back to external API
5. **Cross-app isolation**: Drivers MUST NOT import or call other drivers or native apps. All cross-app communication flows through kernel IPC (events, shell APIs, pipes)

### Extending with a new external application

1. Define or reuse a kernel interface trait in `gctl-core` (e.g., `trait TrackerPort`)
2. Create a feature-gated crate: `crates/gctl-driver-{name}/`
3. Implement the interface trait with the external app's API
4. Register the driver at startup via configuration
5. The driver MUST NOT modify the kernel or shell — it plugs into existing kernel interfaces
6. Cross-app data flows through kernel IPC — the driver MUST NOT couple to other apps

---

## 6. Claude Code Skills — Thin Wrappers over gctl

gctl ships Claude Code slash commands (`.claude/commands/*.md`) as a first-class extension surface. Skills are the outermost layer — **opinionated prompts that invoke gctl CLI commands** and reference spec templates. They follow the same Unix philosophy as shell scripts: compose small tools into higher-level workflows.

### Relationship to Other Layers

```mermaid
flowchart LR
  Skill["/review-specs\n(.claude/commands/review-specs.md)"]
  Skill -->|"reads"| Specs["specs/*.md\n(context)"]
  Skill -->|"invokes"| CLI["gctl CLI\n(commands)"]
  Skill -->|"formats"| Output["Structured output\n(for the user)"]
```

Skills sit **outside** the gctl binary. They are Markdown prompt files that tell Claude what to do using gctl's existing capabilities. They are analogous to shell scripts that compose Unix commands — the script itself has no logic; the commands do the work.

### Skill Rules

1. **Skills MUST be thin wrappers.** A skill is a Markdown prompt that tells Claude *what to do* using `gctl` CLI commands, spec file references, and output formatting instructions. It MUST NOT contain substantial business logic.
2. **Logic lives in gctl.** If a skill needs computation, querying, or mutation, that capability MUST exist as a `gctl` CLI command or utility first. The skill invokes it; it does not reimplement it.
3. **Skills compose gctl commands.** A skill MAY chain multiple commands (e.g., `gctl sessions` then `gctl analytics overview` then `gctl tree`) and synthesize the results.
4. **Skills reference specs as context.** Skills SHOULD load relevant `specs/` files to ground Claude's behavior in the project's architecture and domain model.
5. **Skills are project-scoped.** Skill files live in `.claude/commands/` and are versioned with the repo. They evolve alongside the specs and CLI they reference.

### Anatomy of a Skill

```markdown
# .claude/commands/my-skill.md

One-line description of what the skill does.

## Instructions

### 1. Load Context
Read these files: `specs/architecture/README.md`, `specs/principles.md`, ...

### 2. Do the Work
Run `gctl <command>` to gather data.
Run `gctl <command>` to perform the action.
Analyze results against the loaded spec context.

### 3. Output Format
Format results as: ...

$ARGUMENTS
```

### Shipped Skills

| Skill | What It Does | gctl Commands / Specs Used |
|-------|-------------|---------------------------|
| `/audit-specs` | Check specs against principles and invariants | Reads `specs/`, applies `specs/principles.md` rules |
| `/review-specs` | Identify spec gaps, contradictions, ambiguities | Reads `specs/`, cross-references for completeness |
| `/status` | System health overview | `gctl status`, `gctl sessions`, `gctl analytics overview` |
| `/cost-report` | Summarize cost and token usage | `gctl analytics cost`, `gctl analytics cost-breakdown`, `gctl analytics daily` |
| `/trace` | Investigate a session's trace tree | `gctl tree <id>`, `gctl spans --session <id>` |
| `/dispatch` | Prepare dispatch recommendation for agent work | `gctl sessions`, `gctl status`, `gctl analytics overview` |

### Anti-Patterns

- **Fat skills**: A skill that parses DuckDB output, computes aggregates, or applies business rules inline. Move that logic into a `gctl` CLI command.
- **Duplicate logic**: A skill that reimplements what `gctl analytics` or `gctl query` already provides. Invoke the command instead.
- **Ungrounded skills**: A skill that does not load spec context and relies solely on Claude's training data for project-specific decisions. Always load the relevant specs.

### Extending with a new skill

1. Identify what gctl CLI commands and spec files the skill needs
2. If the skill requires computation that no command provides, **build the command first**
3. Create `.claude/commands/{skill-name}.md`
4. Structure: load context (spec files) → invoke gctl commands → format output
5. The skill MUST be a thin orchestration layer — all logic lives in gctl

---

## Layer Decision Guide

When adding new functionality, use this guide to decide where it belongs:

| Question | If Yes | Layer |
|----------|--------|-------|
| Is it agent-agnostic and provides a mechanism (not policy)? | Yes | **Kernel** |
| Does it dispatch, route, or format I/O? | Yes | **Shell** |
| Does it own state, have domain logic, and orchestrate multiple primitives? | Yes | **Native Application** |
| Does it do one thing, compose via pipes, and have no domain model? | Yes | **Utility** |
| Is it an external tool with its own state that connects via a kernel interface? | Yes | **External Application** (with driver) |
| Is it an opinionated prompt that invokes gctl commands? | Yes | **Skill** |

When in doubt, start as a utility. Promote to an application only when the utility accumulates its own state and domain rules. External tools are always external applications — they connect through drivers and communicate via kernel IPC, never through direct coupling.

---

## Execution Model — Processes, Users, and Scheduling

An extension of the Unix metaphor to cover processes and users — humans and agents alike.

| Unix Concept | gctl Equivalent |
|---|---|
| User (`uid`) | User (human or agent persona, with `user_id`) |
| Process (`pid`) | Agent Session (`session_id`) |
| `fork` / `exec` | Dispatch — orchestrator picks up a work item and spawns a session |
| `init` / `systemd` | Orchestrator — schedules, retries, reconciles |
| Job queue | Issue backlog (`todo` → `in_progress`) |
| `wait(pid)` / dependency | Issue dependency graph — blocked until predecessors complete |
| `cgroups` / `ulimit` | Guardrails — cost caps, token budgets, loop detection |
| `/proc/<pid>` | Telemetry — live span tree, session state, resource usage |
| Signal (`SIGTERM`, `SIGKILL`) | Alert → guardrail intervention (warn, pause, terminate) |
| `setuid` / capabilities | Agent capability grants — what tools and resources a session may use |
| Login / `su` | Persona adoption — agent assumes a configured persona at dispatch time |

---

### 7. Users

In Unix, every process runs as a user identified by a `uid`. In gctl, every session runs on behalf of a **user** — a human or an agent persona, each with a `user_id`.

```
user_id  name         kind     capabilities
──────────────────────────────────────────────────
p0       system       system   all (kernel-internal only)
p1       alice        human    read, write, dispatch, review
p2       claude-code  agent    read, write, bash, dispatch
p3       reviewer-bot agent    read, comment
p4       nightly-run  agent    read, dispatch, net
```

#### 7.1 User Types

**Human users** correspond to real team members. Their sessions are interactive; they spawn agent sessions explicitly (e.g. `gctl board assign BACK-42 --agent claude-code`).

**Agent personas** are configured identities with a fixed capability set. A persona is like a Unix system account (`www-data`, `postgres`) — it defines *what* the agent may do, not *who* the agent is at the model level. The same LLM (Claude) can run under different personas with different capability grants.

```toml
# Example: WORKFLOW.md persona section
[persona.reviewer-bot]
kind       = "agent"
model      = "claude-sonnet-4-6"
tools      = ["read", "comment"]        # capability allowlist
cost_limit = { per_session = "0.10" }   # guardrail binding
```

#### 7.2 Persona ↔ Unix Analogy

| Unix | gctl |
|---|---|
| `uid=0` (root) | `system` user — kernel-internal, never dispatched from user code |
| Named system user (`postgres`) | Agent persona (`claude-code`, `reviewer-bot`) |
| `sudo` / `setuid` | Capability grant — promote a session's allowed tools for a specific issue |
| `getent passwd` | `gctl user list` |
| `/etc/sudoers` | WORKFLOW.md `[persona.*]` capability config |

#### 7.3 Session → User Binding

Every session record carries a `user_id`. Telemetry, guardrail decisions, cost attribution, and audit trails are all keyed to the user.

```sql
-- sessions table (gctl-storage)
user_id     VARCHAR  -- FK → users
session_id  VARCHAR  -- the running "process"
cost_usd    DECIMAL  -- attributed to this user
```

---

### 8. Processes (Sessions)

A **session** is the unit of agent execution — the gctl analogue of a Unix process.

#### 8.1 Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> todo
    todo --> in_progress : dispatch
    todo --> blocked : dep_unresolved
    blocked --> todo : dep_done
    in_progress --> done : success
    in_progress --> paused : guardrail / human
    paused --> in_progress : human_resume
    in_progress --> failed : error_exit
    failed --> todo : retry_eligible
    done --> [*]
```

| State | Unix Analogy | Description |
|---|---|---|
| `todo` | Ready queue | Work item exists, no session running |
| `blocked` | `sleep(fd)` / `wait(pid)` | Dependency not yet resolved |
| `in_progress` | Running (`R`) | Active session holds the slot |
| `paused` | Stopped (`T`) / `SIGSTOP` | Guardrail or human intervention |
| `done` | Exited (`Z` → reaped) | Issue closed, session archived |
| `failed` | Non-zero exit | Session terminated with error, eligible for retry |

#### 8.2 Dispatch — `fork` + `exec`

The **Orchestrator** is the gctl equivalent of `init`/`systemd` — the always-running supervisor that manages the lifecycle of all agent sessions.

**Dispatch flow:**

```
1. Orchestrator polls: SELECT issues WHERE status = 'todo' AND deps_met = true
2. Reserve slot:       UPDATE issues SET status = 'in_progress', session_id = ? WHERE id = ?
3. Fork context:       Build prompt from WORKFLOW.md template + issue frontmatter
4. Exec agent:         Spawn session under configured persona
5. Monitor:            Ingest OTel spans → update session state
6. Reap:               On session exit, transition issue to done/failed; release slot
```

Step 2 is a single atomic write — the DuckDB single-writer invariant prevents double-dispatch races.

#### 8.3 Dependency Graph — `wait(pid)`

Issues declare dependencies via `blocked_by: [BACK-40, BACK-41]` in their frontmatter. The orchestrator only promotes an issue to `todo` (dispatch-eligible) when all blocking issues are `done`.

```
BACK-40 (done) ─┐
                 ├─→ BACK-42 (now eligible) ─→ dispatch
BACK-41 (done) ─┘

BACK-43 (blocked by BACK-42) → stays blocked until BACK-42 is done
```

This is the equivalent of `wait(pid)` / `waitpid()` — a dependent issue cannot proceed until its dependency exits successfully.

```sh
gctl board graph                        # visualize the dependency DAG
gctl board ready                        # list issues eligible for dispatch
gctl board blocked --reason deps        # list issues blocked on dependencies
```

#### 8.4 Slots and Concurrency

The orchestrator respects a configurable **slot count** — the maximum number of concurrently running sessions per user or globally. This mirrors Unix process limits (`ulimit -u`, `MaxStartups`).

```toml
[orchestrator]
max_concurrent_sessions = 4        # global slot pool
max_sessions_per_user.agent = 2    # per-persona cap
```

When all slots are full, newly eligible issues remain in `todo` until a slot opens. No busy-waiting — the orchestrator reconciles on session-exit events and on a configurable polling interval.

---

### 9. Guardrails as cgroups

Unix `cgroups` limit CPU, memory, and I/O per process group. gctl **Guardrails** play the same role for agent sessions:

| cgroup | gctl Guardrail |
|---|---|
| `cpu.max` | Token budget — max tokens per session |
| `memory.max` | Context window guard — truncate or compact before overflow |
| `blkio.weight` | Rate limiting — requests/minute to external APIs |
| `pids.max` | Sub-agent spawn cap — max child sessions per parent |
| `cgroup.freeze` | Pause — guardrail suspends session pending human review |
| `cgroup kill` | Terminate — guardrail hard-stops a runaway session |

Guardrail policies are attached to **users**, not individual sessions — just as cgroup policies are attached to users or services in systemd, not individual PIDs.

```toml
[guardrails.user.claude-code]
max_cost_per_session  = "1.00"
max_loop_iterations   = 20
allowed_commands      = ["cargo", "git", "gctl"]
```

---

### 10. Telemetry as `/proc`

In Unix, `/proc/<pid>` exposes live process state. In gctl, **OTel telemetry** is the equivalent — every running session emits structured spans that the kernel stores and exposes via the shell.

```sh
gctl tree <session_id>          # like ls /proc/<pid>/ — span hierarchy
gctl sessions --status running  # like ps aux
gctl status                     # like top — overview of all running sessions
gctl spans <session_id>         # like /proc/<pid>/status — raw resource data
```

The telemetry layer is always on. You cannot opt a session out of `/proc` — observability is a kernel primitive, not an application feature.

---

### 11. Signals and Alerts

Unix signals interrupt running processes. gctl **alerts** are the equivalent — guardrail-triggered or human-triggered interrupts that change session behavior.

| Signal | gctl Alert / Action |
|---|---|
| `SIGTERM` | Graceful stop — finish current tool call, then exit |
| `SIGKILL` | Hard terminate — immediate session end, no cleanup |
| `SIGSTOP` | Pause — session suspended, awaiting human review |
| `SIGCONT` | Resume — human approves continuation |
| `SIGUSR1` | Custom hook — `PostToolUse` guardrail intervention |

Alerts are emitted by the Guardrails engine and delivered to the running session via the kernel's alert channel. Human operators can also send signals directly via the CLI:

```sh
gctl session pause  <session_id>    # SIGSTOP
gctl session resume <session_id>    # SIGCONT
gctl session stop   <session_id>    # SIGTERM
gctl session kill   <session_id>    # SIGKILL
```

---

### 12. Multi-Agent Teams — Process Groups

Unix **process groups** let you signal a tree of related processes together. gctl **agent teams** are the equivalent — a lead session that spawns sub-sessions, all operating on related work.

```mermaid
graph TD
    lead["lead session (BACK-42)"]
    lead --> t["sub-session: test-runner (BACK-42-tests)"]
    lead --> d["sub-session: doc-writer (BACK-42-docs)"]
    lead --> r["sub-session: reviewer-bot (BACK-42-review)"]
```

1. The lead holds the issue slot; sub-sessions are scoped to the parent session.
2. Sub-sessions share the parent user's capability grants but MAY be further restricted.
3. Killing the lead session (`SIGKILL`) propagates to all sub-sessions — equivalent to `kill(-pgid)`.
4. Cost and token usage roll up to the parent issue for attribution.

```sh
gctl session tree <lead_session_id>      # show process group tree
gctl session kill --group <session_id>   # kill the whole group
```

---

### 13. Everything is a File

Unix's most powerful abstraction is that every resource — devices, sockets, pipes, proc state — is a file. gctl applies this principle to its storage model: **everything the kernel persists is a file**, owned and managed by the kernel, not by individual applications.

#### 13.1 DuckDB → Parquet → R2

DuckDB is gctl's filesystem. But DuckDB files are local, mutable, and single-writer. To cross device and team boundaries, the kernel serializes state as **Parquet** — the universal, columnar, open format that both DuckDB and Cloudflare Workers can read natively.

```mermaid
flowchart TD
    A["Local (DuckDB in-process)"]
    B["Parquet files (~/.local/share/gctl/sync/)"]
    C["R2 bucket (Cloudflare)"]
    D["Remote consumers (dashboards, team views, cross-device queries)"]

    A -->|"COPY … TO … FORMAT PARQUET"| B
    B -->|"gctl sync push (Cloud Sync kernel primitive)"| C
    C -->|"Workers / D1 / Analytics Engine read directly"| D
```

The sync layer is a **kernel responsibility**, not an application concern. Applications write through the shell (DuckDB). The kernel handles durability, format translation, and replication — just as the Unix kernel owns block I/O and the VFS layer, not userspace programs.

#### 13.2 Everything is a File — Mapping

| Unix Resource | File Representation | gctl Equivalent |
|---|---|---|
| Process state | `/proc/<pid>/status` | Session Parquet row, OTel span |
| Block device | `/dev/sda` | DuckDB WAL segment |
| Network socket | `/proc/net/tcp` | HTTP API `:4318`, MITM proxy logs |
| Config | `/etc/`, dotfiles | WORKFLOW.md, AGENTS.md, driver configs |
| Audit log | `/var/log/audit/` | `spans` table, `net_traffic` table |
| Shared memory | `/dev/shm/` | DuckDB in-memory (`:memory:`) for tests |
| Archive / backup | tar / dump | Parquet export under `~/.local/share/gctl/sync/` |
| Cloud object store | NFS / remote mount | R2 bucket — Parquet files, read by Workers |

#### 13.3 Kernel Owns All I/O

Applications MUST NOT write Parquet directly or sync to R2 themselves. They write rows through the Shell (SQL via DuckDB or HTTP API). The Kernel's Cloud Sync primitive handles:

1. **Serialization** — `COPY … TO … (FORMAT PARQUET)` on schedule or trigger
2. **Partitioning** — by device ID and date for parallel, non-conflicting multi-device writes
3. **Upload** — `PUT` to the R2 bucket via the kernel's sync adapter
4. **Conflict resolution** — last-write-wins with device-partition isolation; no row-level merging needed
5. **Remote query** — Cloudflare Workers query R2 Parquet directly via DuckDB WASM or Workers Analytics Engine

```sh
gctl sync status                  # what's been exported, when
gctl sync push --table sessions   # manual export trigger
gctl sync push --all              # full export
gctl sync pull --since 7d         # pull remote Parquet into local DuckDB
```

---

### 14. Execution Model Summary

```
gctl OS Model

  Users (uid)                     humans and agent personas
  ├── capability grants           setuid / sudoers
  └── cost/resource quotas        cgroups / ulimit

  Processes / Sessions (pid)      Running units of execution
  ├── lifecycle states            ps / proc states (R, T, Z)
  ├── dependency graph            wait(pid) / waitpid()
  ├── concurrency slots           pids.max / MaxStartups
  └── sub-sessions                process groups (pgid)

  Orchestrator (init/systemd)     Dispatch, retry, reconciliation
  ├── dependency-aware scheduler  eligible = deps_met AND slot_free
  └── reconciliation loop         systemd watchdog / restart policy

  Guardrails (cgroups)            Resource limits per user
  ├── token / cost budgets        cpu.max / memory.max
  ├── loop detection              watchdog timeout
  └── command gateway             seccomp / allowlist

  Telemetry (/proc)               Live session state, span trees
  Alerts (signals)                SIGTERM / SIGKILL / SIGSTOP / SIGCONT
  Shell (bash)                    CLI + HTTP API gateway to kernel
  Filesystem (DuckDB)             Structured, queryable system state
  Everything is a file            DuckDB → Parquet → R2 (kernel owns all I/O)
  ├── local state                 DuckDB (single-writer, in-process)
  ├── portable format             Parquet (columnar, open, DuckDB + Workers native)
  └── cloud sync                  R2 bucket (device-partitioned, conflict-free)
```

The key design insight: **agents are users, not just tools.** Giving agents a first-class user identity with Unix-like properties — UID scoping, capability grants, resource limits, process trees — makes the entire system composable, auditable, and safe by default.
