# GroundCtrl — Product Requirements Document

> Tools and workflows for harness engineering — so agents work with the right context and guardrails, and humans deep-think on what matters and review work.
>
> Instantiates the [PRD template](../../apps/gctrl-board/specs/workflows/prd-template.md) for gctrl itself.

## The Problem

Coding agents are powerful but unmanaged. Today's developer using Claude Code, Codex, Aider, or custom agents faces a set of compounding problems that no single tool addresses:

1. **No visibility.** You don't know what your agent did, how much it cost, or whether it's stuck in a loop — until the bill arrives or the PR is a mess. There's no `top` or `ps` for agent work.

2. **No guardrails.** Agents can force-push to main, blow through token budgets, hammer APIs without rate limits, or produce 5,000-line diffs. There's no `ulimit` or `cgroup` equivalent.

3. **No orchestration.** Dispatching work to agents is manual. There's no job queue, no dependency graph, no retry logic, no concurrency control. You can't say "work on these 5 issues in priority order, max 2 at a time."

4. **No shared context.** Agents start every session from scratch. Team knowledge — conventions, architecture docs, past decisions, crawled documentation — isn't systematically available. There's no shared filesystem for agent context.

5. **No capacity planning.** You can't answer "how many issues can our agent team close per week?" or "are we on track to ship this milestone?" Agent work is invisible to project planning.

6. **Tool fragmentation.** Observability (Langfuse), project tracking (Linear), knowledge bases (Obsidian), infrastructure (AWS/Cloudflare) — each is a separate silo. Agents can't reason across them. Humans context-switch between them.

These problems compound: without visibility you can't set guardrails, without guardrails you can't trust agents with orchestration, without orchestration you can't plan capacity, without capacity planning you can't staff projects.

## Our Take: Harness Engineering

**The fundamental insight is that the bottleneck is not agent capability — it's the harness.** Agents are already powerful enough to ship real work. What's missing is the engineering around them: the context they receive, the guardrails that keep them safe, the orchestration that assigns them work, and the workflows that let humans focus on the decisions that actually matter.

**Harness engineering** is the discipline of building this infrastructure. The goal: agents operate with the right context and within safe boundaries, while humans spend their time on deep thinking — architecture, priorities, trade-offs, review — instead of babysitting agents, copy-pasting prompts, or manually dispatching work.

Unix solved the analogous problem for human computing: processes need scheduling, resource limits, a filesystem, IPC, and observability (`/proc`, `top`, `ps`). These are OS-level concerns — not application concerns. When every application reinvents process management, you get Windows 3.1. When the OS handles it, you get Unix.

gctrl applies the Unix model to harness engineering:

| Problem | Unix Solution | gctrl Solution |
|---------|--------------|---------------|
| No visibility | `/proc`, `top`, `ps`, `strace` | OTel telemetry, trace trees, cost analytics |
| No guardrails | `ulimit`, `cgroups`, `seccomp` | Policy engine: budgets, loop detection, command allowlists |
| No orchestration | `init`, `systemd`, job queues | Orchestrator: dispatch, retry, dependency DAG, concurrency slots |
| No shared context | Filesystem (`/home`, `/etc`, NFS) | Context manager: docs, configs, snapshots — local-first, sync to cloud |
| No capacity planning | Resource accounting, `sar` | Throughput metrics, forecasts from telemetry data |
| Tool fragmentation | Everything is a file, pipes, sockets | Drivers for Linear/GitHub/Notion/Phoenix, kernel IPC, unified CLI |

**The kernel is small and always present.** You get telemetry, storage, guardrails, and orchestration by running `gctrl serve` — no config, no cloud, no Docker. Everything else is optional: applications, drivers, cloud sync, browser control. Complexity is opt-in.

**Agents work with context, not from scratch.** The context manager, crawled docs, and project snapshots mean every agent session starts with the knowledge it needs — conventions, architecture, past decisions. Humans invest once in curating context; every agent session benefits.

**Humans review, not babysit.** Guardrails and orchestration handle the operational concerns (budgets, retries, concurrency, safety) so humans can focus on what only they can do: setting direction, making architectural trade-offs, and reviewing output. The human role shifts from dispatcher to decision-maker.

**Local-first, cloud-optional.** Everything works offline on your laptop. Cloud sync (Cloudflare R2) layers on when you need team visibility or cross-device access. No vendor lock-in — the data is Parquet and markdown.

**Adapt, don't replace.** gctrl connects to tools you already use (Linear, Notion, Obsidian, Phoenix) via drivers. It provides the kernel underneath, not a replacement for your workflow.

## Design Principles

1. **Human time on what matters.** Every feature MUST reduce human time spent on operational mechanics (dispatching, monitoring, copy-pasting context) and increase human time available for deep thinking (architecture, priorities, trade-offs, review).
2. **Context is infrastructure, not manual labor.** Agents MUST receive the right context automatically — conventions, docs, project state. Humans curate context once; the harness delivers it to every session.
3. **Usable out of the box by one person.** `cargo install gctrl && gctrl serve` — no config files, no cloud accounts, no Docker. A solo developer gets telemetry, storage, guardrails, and orchestration immediately.
4. **Small kernel, optional everything else.** The kernel has four core primitives. Network control, browser control, cloud sync, and the scheduler are extensions. All applications and drivers are optional.
5. **Adapt, don't replace.** Connect to tools you already use via drivers. Shipped applications (gctrl-board, Observe & Eval) are defaults, not mandates.
6. **OS layer is stable; applications evolve fast.** The telemetry format, storage schema, and CLI change rarely. Applications ship, iterate, and break independently.
7. **Applications share primitives, not state.** Apps use the same storage but own their table namespaces. Cross-app data flows through kernel events, not direct table joins.
8. **Agents are first-class consumers.** Every feature is CLI/API-first and automatable. No browser-only UIs.
9. **Local-first, cloud-optional.** The kernel works fully offline. Cloud sync is opt-in.

## Target Users

### Primary: Individual Developer with Agents

A solo developer running one or more coding agents. Wants to know what agents are doing, how much they cost, and stop them from breaking things.

**Day-one value (zero config):**

| Need | What They Use |
|------|-------------|
| "What did my agent do and how much did it cost?" | Telemetry + analytics |
| "Prevent my agent from force-pushing to main" | Guardrails |
| "Dispatch work to my agent and track progress" | Orchestrator + gctrl-board |
| "What should my agent work on next?" | gctrl-board |
| "Crawl these docs and make them agent-ready" | Net utilities + context manager |
| "Share project conventions with my agent" | Context manager (configs) |

### Secondary: Small Team with Multiple Agents

A team of 2-10 developers, each with their own agents, working on a shared codebase.

**Added value (add drivers as needed):**

| Need | What They Use |
|------|-------------|
| "Sync our Linear/GitHub issues to gctrl orchestration" | Drivers (driver-linear, driver-github) |
| "View and edit specs in Obsidian" | Driver-obsidian |
| "Export traces to Phoenix for LLM analysis" | Driver-phoenix |
| "How is our team's agent adoption trending?" | Observe & Eval |
| "Can we ship this milestone on time?" | Capacity Engine |
| "Orchestrate 5 agents across 20 issues" | Orchestrator with concurrency config |
| "Share crawled docs and conventions across the team" | Context manager + cloud sync (R2) |

## What We're Building

### The Kernel (Always Present)

Four core primitives that every agent team needs:

**Telemetry** — The `/proc` of agent work. Ingests OpenTelemetry spans, tracks sessions, attributes costs. Every agent operation is observable. You can always answer "what happened, how long, how much."

**Storage** — The filesystem. Embedded DuckDB for structured data (sessions, spans, tasks). Filesystem for content (crawled docs, configs, snapshots). Works offline, syncs to cloud when needed.

**Guardrails** — The `ulimit` + `cgroups`. Policy engine that enforces cost limits, detects error loops, gates commands, protects branches. Attached to user personas, not individual sessions.

**Orchestrator** — The `init`/`systemd`. Dispatches agent sessions to work on tasks. Manages retry with backoff, dependency DAGs, concurrency slots. Agent-agnostic — works with any agent that accepts a prompt.

### Kernel Extensions (Optional)

| Extension | What It Solves |
|-----------|---------------|
| **Context Manager** | Agents and humans need shared access to docs, configs, and project snapshots. Stores content as markdown, indexes in DuckDB, syncs to R2. |
| **Scheduler** | Deferred and recurring tasks. Platform adapters: tokio (local), launchd (macOS), Durable Object Alarms (Cloudflare). |
| **Network Control** | MITM proxy for traffic visibility, domain allowlists, rate limiting. |
| **Browser Control** | CDP daemon for browser automation. Persistent Chromium with ref system. |
| **Cloud Sync** | R2 Parquet export for analytics, markdown sync for knowledge. Device-partitioned, conflict-free. |

### Applications (All Optional)

**gctrl-board** — Lightweight project management and kanban. Issues with status lifecycle, dependency graph, agent assignment, auto-transitions from kernel events. The first application built on gctrl.

**Observe & Eval** — Langfuse-grade analytics, local-first. Cost/token analytics, latency percentiles, trace exploration, scoring (human + auto + model), prompt version management. Everything Langfuse shows in its dashboard, gctrl can produce from local DuckDB.

**Capacity Engine** — Throughput measurement and delivery forecasting. Answers "how many issues can our agents close per week?" and "are we on track for this milestone?" by correlating telemetry with project data.

### Utilities (Composable Tools)

| Utility | What It Does |
|---------|-------------|
| `gctrl net fetch` | Fetch a URL, convert to markdown |
| `gctrl net crawl` | Crawl a site, extract readable content |
| `gctrl net compact` | Compact crawled pages into LLM-ready context |
| `gctrl context add/list/compact` | Manage agent context (docs, configs, snapshots) |
| `gctrl browser goto/snapshot` | Browser automation |
| `gctrl query` | Guardrailed data access for agents |

### External App Integration (Drivers)

gctrl does not replace your tools — it connects to them:

| Category | Apps | What the Driver Does |
|----------|------|---------------------|
| **Project Tracking** | Linear, GitHub Issues, Notion | Bidirectional issue sync, dispatch from external issues |
| **Knowledge & Docs** | Obsidian | Mount specs as vault, edit in Obsidian UI |
| **Observability** | Arize Phoenix, Langfuse, SigNoz | Export traces/evals/scores |
| **Agents** | Claude Code, Codex, Aider, custom | Orchestrator dispatches via CLI |

Zero drivers = gctrl works standalone. Add drivers as your workflow grows.

## Business Use Cases

### 1. Agent Cost Visibility & Control

**Problem:** A team running 10 agent sessions/day has no idea what they're spending until the monthly bill. One runaway session can cost $50+.

**Solution:** Real-time cost tracking per session, per agent, per model. Budget guardrails pause or halt sessions that exceed thresholds. Daily/weekly cost trends. Per-issue cost attribution (via gctrl-board).

**Metric:** Time-to-detect runaway session < 30 seconds (vs. end-of-month bill).

### 2. Agent Safety & Compliance

**Problem:** Agents can execute destructive operations — force-push, delete branches, run arbitrary commands. In regulated environments, you need an audit trail of every agent action.

**Solution:** Command allowlists, branch protection, diff size gates. Full audit trail in DuckDB (every span, every command, every cost). Loop detection catches agents stuck in retry spirals.

**Metric:** Zero unreviewed force-pushes to main. 100% audit coverage of agent actions.

### 3. Multi-Agent Orchestration

**Problem:** Dispatching work to agents is manual copy-paste of issue descriptions into prompts. No retry on failure. No dependency ordering. No concurrency control.

**Solution:** Orchestrator dispatches agents to tasks automatically, respects dependency DAGs, retries with exponential backoff, enforces per-user and global concurrency limits. Agent-agnostic — works with Claude Code, Codex, Aider, or any CLI agent.

**Metric:** Human time spent dispatching agent work → near zero. Agent utilization → bounded by concurrency config, not by human availability.

### 4. Team Knowledge as Agent Context

**Problem:** Every agent session starts from scratch. Team conventions, architecture docs, crawled API references — agents don't have access unless you paste them manually.

**Solution:** Context manager stores docs, configs, and snapshots. Agents load context at session start. `gctrl context compact` produces a single LLM-ready document. Sync to R2 makes context available across devices.

**Metric:** Agent "what is the project convention for X?" questions → answered from context, not from human.

### 5. Capacity Planning with Agent Teams

**Problem:** "Can we ship this milestone by Friday?" is unanswerable when half the work is done by agents whose throughput is unknown.

**Solution:** Capacity engine correlates telemetry (how long tasks take, success rates, cost per issue) with project data (open issues, priorities, dependencies). Produces throughput forecasts.

**Metric:** Delivery date predictions within 20% accuracy by week 4 of usage.

### 6. Local-First Observability (Langfuse Alternative)

**Problem:** Cloud-hosted LLM observability (Langfuse, Phoenix) requires sending all your prompts and completions to a third party. For security-conscious teams, this is a non-starter.

**Solution:** Full Langfuse-grade observability running locally in DuckDB. Cost analytics, latency percentiles, trace exploration, scoring, prompt management. Data never leaves your machine unless you explicitly sync.

**Metric:** Feature parity with Langfuse core (traces, scores, cost analytics, prompt management) at zero data-transfer cost.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for milestones, task breakdown, and open questions.

## Non-Goals

- **Not a cloud platform.** gctrl is local-first. Cloud sync is optional. We don't host dashboards or run agents in the cloud.
- **Not an agent framework.** gctrl doesn't build agents — it manages them. It works with any agent that accepts a prompt and exits with a status code.
- **Not a replacement for Linear/GitHub/Notion.** gctrl connects to these tools via drivers. It provides the kernel underneath, not a replacement.
- **Not enterprise-first.** Designed for individuals and small teams. Enterprise features (SSO, RBAC, compliance) are future work, not core.

## Success Criteria

1. A solo developer can install gctrl, run `gctrl serve`, and get agent visibility + guardrails in < 5 minutes.
2. A team of 5 can sync agent telemetry across devices via R2 in < 30 minutes of setup.
3. An agent working on an issue has access to project context (conventions, docs, issue state) without human intervention.
4. Cost overruns are detected and halted within 30 seconds.
5. The orchestrator can dispatch and manage 10 concurrent agent sessions without human intervention.

---

*For architecture details, see [../../architecture/](../../architecture/). For implementation details, see [../../implementation/](../../implementation/).*
