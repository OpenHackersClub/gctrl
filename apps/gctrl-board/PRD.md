# gctrl-board — Product Requirements Document

> Agent-native project management, observability, and evaluation for human+agent teams. **Track issues, understand agent behavior through traces and prompts, and close the feedback loop with eval scoring.** A native application in the gctrl Unix architecture — rides on the shell and kernel (not consumed as a library). Includes a **web UI** (kanban board + agent OTel dashboard) and CLI surface.
>
> Instantiates the [PRD template](specs/workflows/prd-template.md).

## Architectural Position

gctrl-board is a **native application** — the Unix equivalent of `vim` or `git`. It is NOT a library consumed by the shell. It is a standalone app that:

1. **Rides on the shell** — invokes kernel HTTP API (`/api/board/*`, `/api/analytics/*`, `/v1/traces`) via the shell's HTTP surface, never accesses DuckDB directly.
2. **Has its own UI** — a web dashboard (kanban + agent OTel analytics) served from the app, not just CLI commands.
3. **Uses kernel primitives** — Storage (namespaced `board_*` tables), Telemetry (session/span data), Scheduler (Task visualization), Kernel IPC (event subscriptions).
4. **Is optional** — like any Unix app, it can be installed or removed without affecting kernel/shell operation.

```
┌──────────────────────────────────────────────────┐
│  gctrl-board (Native Application)                 │
│  ├─ Web UI (kanban + OTel dashboard)             │
│  ├─ CLI surface (gctrl board ...)                 │
│  └─ Services (BoardService, EvalService, etc.)   │
├──────────────────────────────────────────────────┤
│  Shell (HTTP API :4318, CLI dispatcher)          │
├──────────────────────────────────────────────────┤
│  Kernel (Storage, Telemetry, Scheduler, IPC)     │
└──────────────────────────────────────────────────┘
```

## Problem

1. **No shared issue tracker between humans and agents.** Humans use Linear/GitHub Issues; agents have no native way to see, claim, or report on issues. Context is manually copy-pasted into prompts.

2. **No cost attribution per issue.** You know what a session cost, but not what an issue cost across multiple sessions and agents. There's no way to answer "how much did BACK-42 cost to complete?"

3. **No dependency management for agent work.** Agents can't express "don't start X until Y is done." There's no DAG of blocking relationships.

4. **No auto-transitions.** When an agent opens a PR, the issue should move to `in_review` automatically. When a PR merges, it should move to `done`. Today this requires manual status updates.

5. **No way to understand why an agent succeeded or failed.** The kernel captures OTel traces and prompt versions, but there's no per-issue view that shows what context the agent received, what reasoning path it took, and where it went wrong. You can see spans in isolation — you can't see the story of an issue.

6. **No visual dashboard for agent work.** All interaction is CLI-only. There's no kanban board to drag issues across columns, no charts showing cost trends, no trace timeline to visualize agent execution. Humans need a visual surface to manage and observe agent work at scale.

7. **No context quality feedback loop.** Agents may start work with insufficient or stale context (missing specs, outdated docs, no architecture guidance). There's no systematic way to audit what context was provided vs what was needed, or to score context quality after the fact.

8. **No eval criteria for agent work.** You can review a PR, but there's no structured way to score agent work across dimensions (correctness, test coverage, spec adherence, cost efficiency), track scores over time, or correlate scores with prompt versions or context quality. No Langfuse-style evaluation pipeline.

## Our Take

**gctrl-board is the primary user-facing application in the gctrl OS.** It is a native app — not a library, not a shell extension. Like `vim` or `git` in Unix, it rides on the kernel and shell but has its own runtime, its own web server, and its own UI.

**Issues are the human-managed unit of work. Tasks are the agent-managed unit. The board shows both — and shows *how* the agent worked, not just *that* it worked.**

Humans create, prioritize, and assign Issues. Agents create Tasks via the kernel Scheduler. The board visualizes Tasks read-only under their linked Issue. The kernel's telemetry automatically links sessions to issues and accumulates cost/tokens.

The board has **two surfaces**:

1. **Web UI** — a kanban board for issue management + an agent OTel dashboard for observability and evaluation. This is the primary interface for humans managing agent work at scale. Served by the app's own HTTP server (distinct from the kernel's `:4318`).
2. **CLI** — `gctrl board` subcommands for scripting, automation, and quick operations from the terminal.

The board is also the place where humans understand and evaluate agent behavior. For every issue, you can see the full trace (what the agent did), the prompts it received (what context it had), and score the result (how well it did). This closes the harness engineering feedback loop: observe behavior → evaluate quality → improve context and prompts → observe again.

The kernel owns the raw data (`sessions`, `spans`, `prompt_versions`, `eval_scores`). The board owns the per-issue **view layer** and the **web UI** that ties them together into an actionable picture.

## Principles

1. **Issues are for humans, Tasks are for agents.** The board MUST NOT blur the boundary. Humans manage Issues; agents manage Tasks via the Scheduler.
2. **Cost attribution is automatic.** When a session references an issue key, cost accumulates without manual action.
3. **Status transitions are validated.** The kanban lifecycle is enforced — no skipping steps, no going backward (except cancel).
4. **External trackers are peers, not masters.** Sync with Linear/GitHub is bidirectional via drivers, not one-way import.
5. **Every issue is observable.** For any issue, you MUST be able to see what sessions ran, what prompts were used, what traces were produced, and what the agent's reasoning path was.
6. **Context is auditable.** For any issue, you MUST be able to see what context the agent received (prompts, docs, specs) and whether it was sufficient. Context gaps are the most common root cause of agent failure.
7. **Eval is continuous, not one-shot.** Scoring agent work is not just a PR review step — it's a pipeline. Human scores, automated checks (tests pass, coverage delta), and model-based evaluation all feed into the same `eval_scores` table, correlated with prompt versions and context.

## Target Users

### Primary: Developer Dispatching and Evaluating Agent Work

| Need | Surface | Solution |
|------|---------|----------|
| "Create an issue for agent work" | CLI | `gctrl board create BACK "Fix auth bug"` |
| "Assign it to an agent" | CLI | `gctrl board assign BACK-1 claude-code --type agent` |
| "See what's in progress" | Web UI | Kanban board with columns for each status |
| "Drag issue to in_review" | Web UI | Drag-and-drop across kanban columns |
| "How much did this issue cost?" | Web UI | Issue detail panel with accumulated cost, token breakdown |
| "Move to review after PR" | Auto | Auto-transition on PR open event |
| "What did the agent actually do?" | Web UI | Per-issue trace timeline — spans, tool calls, LLM interactions |
| "See cost/latency trends" | Web UI | Agent OTel dashboard — charts for cost by model, latency p95, daily trends |
| "Did the agent have the right context?" | Web UI | Context audit panel — prompts provided vs. referenced |
| "Score this agent's work" | Both | Web UI scoring form or `gctrl board score BACK-1 --name quality --value 0.8` |

### Secondary: Team Lead Reviewing Agent Output and Improving Harness

| Need | Surface | Solution |
|------|---------|----------|
| "What did agents work on this week?" | Web UI | Dashboard: issues by agent, with cost and outcome |
| "Which issues are blocked?" | Web UI | Kanban board highlights blocked issues with dependency edges |
| "Total agent spend on this project" | Web UI | Project-level cost summary widget |
| "Are agents getting better over time?" | Web UI | Eval dashboard — score trend charts by dimension, agent, prompt version |
| "Which prompt version produces the best results?" | Web UI | Prompt analytics — scores correlated with prompt versions |
| "Where are the context gaps?" | Web UI | Context gap report — issues where context was rated insufficient |
| "Export data for scripting" | CLI | `gctrl board list --project BACK --format json` |

## Use Cases

### 1. Issue-to-Agent Dispatch

**Problem:** Manually writing prompts for each agent task.
**Solution:** `gctrl board assign BACK-42 --agent claude-code` creates a Scheduler Task, the orchestrator dispatches a session, telemetry links back to the issue.
**Metric:** Zero manual prompt construction for dispatched issues.

### 2. Cost Transparency Per Issue

**Problem:** Can't attribute agent costs to specific work items.
**Solution:** Session→Issue linking via telemetry. Every session that references `BACK-42` adds its cost/tokens to the issue.
**Metric:** 100% of dispatched sessions linked to their issue within 30 seconds.

### 3. Dependency-Aware Scheduling

**Problem:** Agents start work on issues that depend on unfinished prerequisites.
**Solution:** `gctrl board block BACK-5 --by BACK-3` creates a DAG edge. The orchestrator won't dispatch BACK-5 until BACK-3 is done.
**Metric:** Zero dispatches to blocked issues.

### 4. Per-Issue Agent Behavior Understanding

**Problem:** An agent completed BACK-42 but the PR has subtle issues. You want to understand what happened — what context it had, what reasoning path it took, where it went wrong.
**Solution:** `gctrl board traces BACK-42` shows all sessions and spans for the issue in a trace tree. Each session links to the prompt version used. You can see the agent's tool calls, LLM interactions, errors, and retries — all scoped to the one issue.
**Metric:** Time-to-diagnose agent failure < 2 minutes (vs. manually searching through logs).

### 5. Context Quality Audit

**Problem:** Agent failed on BACK-42 because it didn't know about the rate limiting middleware. The architecture doc existed but wasn't included in the prompt context. There's no systematic way to identify these gaps.
**Solution:** `gctrl board context-audit BACK-42` shows what was provided (prompt content, linked docs, context entries) alongside what the agent referenced or asked about during the session. Gaps are surfaced as missing references.
**Metric:** Context gap detection per issue — "agent referenced X but X was not in provided context."

### 6. Eval Criteria and Scoring (Langfuse-style)

**Problem:** PR review is the only feedback mechanism. There's no way to score agent work across structured dimensions, track quality trends, or correlate scores with prompt or context changes.
**Solution:** Define eval criteria per project (e.g., `quality`, `tests_pass`, `spec_adherence`, `cost_efficiency`). Score each issue from multiple sources: human review, automated checks (test results, coverage delta), model-based evaluation. Scores are stored in the kernel's `eval_scores` table and queryable per issue, per project, over time.
**Metric:** Every completed issue has at least one score within 24 hours. Score trends visible per project per week.

## What We're Building

### Web UI — Kanban Board

The primary visual surface for managing agent and human work. Served by gctrl-board's own HTTP server.

- **Kanban columns** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`. Drag-and-drop to move issues.
- **Issue cards** — title, assignee (human/agent badge), priority, labels, accumulated cost, linked PR count.
- **Issue detail panel** — full issue view with description, comments, events, session links, cost breakdown, acceptance criteria.
- **Dependency visualization** — blocked issues are visually marked; dependency edges shown on hover.
- **Real-time updates** — subscribes to kernel IPC events (session linked, status changed, PR opened) to update the board live.

### Web UI — Agent OTel Dashboard

Per-project and per-issue observability for agent work. Reads from kernel Telemetry via shell HTTP API.

- **Cost overview** — total spend by project, by agent, by model. Time-series chart of daily cost.
- **Session timeline** — for any issue, show all linked sessions chronologically with duration, cost, token count, and outcome (success/failure/cancelled).
- **Trace explorer** — per-issue span tree. Visualize the agent's execution path: tool calls, LLM interactions, errors, retries. Drill into individual spans.
- **Latency distribution** — p50/p95/p99 latency by model, by agent. Identify slow operations.
- **Cost breakdown** — per-session and per-span cost within an issue. Identify expensive spans (large prompts, many retries).
- **Score trends** — eval scores over time by dimension (quality, tests_pass, cost_efficiency). Compare across agents and prompt versions.
- **Alert panel** — active alert rules and recent firings (cost threshold breaches, error loops).

### Issue CRUD + Kanban Lifecycle

- Projects with auto-incrementing keys (`BACK-1`, `BACK-2`)
- Issue creation, listing, detail view (both web UI and CLI)
- Forward-only status transitions: `backlog → todo → in_progress → in_review → done` (any → `cancelled`)
- Transition validation enforced at storage layer
- Auto-emitted events on every status change

### Agent Integration

- Assign issues to agents (`--type agent`)
- Session→Issue linking with cost/token accumulation
- Auto-transitions on kernel events (session start, PR open, PR merge)
- Decompose issues into sub-issues

### Dependency Graph (DAG)

- Block/unblock relationships between issues
- Cycle detection (reject edges that would create cycles)
- Auto-unblock propagation when blockers complete

### Comments & Events

- Human and agent comments on issues
- Full event audit trail (status changes, assignments, session links)

### Per-Issue Trace Explorer

The board surfaces kernel telemetry data **scoped to each issue** — connecting the dots between issues, sessions, spans, and prompts that the kernel stores separately.

- **Trace view** — for any issue, list all linked sessions with their span trees. Visualize the agent's execution path: tool calls, LLM interactions, errors, retries.
- **Cost breakdown** — per-session and per-span cost within an issue. Identify expensive spans (large prompts, many retries).
- **Timeline** — chronological view of all sessions that worked on an issue, with duration and outcome.
- **Error drill-down** — filter to error spans, see what failed and why. Link errors to the agent's reasoning context at the point of failure.

Data source: kernel `sessions`, `spans` tables joined via `board_issues.id` → session linking.

### Context Audit

For each issue, audit what context the agent received and whether it was sufficient.

- **Prompt inspection** — show the rendered prompt for each session (from `prompt_versions` via `session_prompts`). Display the full prompt content, token count, and which template/version produced it.
- **Context inventory** — list all context entries (docs, configs, snapshots from the context manager) that were available or referenced during the session.
- **Gap detection** — compare what the agent asked about or referenced in its spans against what was provided in the prompt. Surface missing references as context gaps.
- **Context scoring** — human or model-based score on context sufficiency per issue. Stored in `eval_scores` with `name = 'context_quality'`.

Data source: kernel `prompt_versions`, `session_prompts`, `context_entries` tables.

### Eval Criteria & Scoring

Structured evaluation of agent work, inspired by Langfuse's scoring model. The board provides the per-issue evaluation workflow; scores are stored in the kernel's `eval_scores` table.

- **Eval dimensions** — configurable per project. Default dimensions: `quality` (overall work quality), `tests_pass` (automated: did tests pass), `coverage_delta` (automated: test coverage change), `spec_adherence` (human: did the agent follow specs), `cost_efficiency` (automated: cost vs. complexity), `context_quality` (human: was the context sufficient).
- **Score sources** — three types, matching Langfuse:
  1. **Human** — manual scores from PR review or Show & Tell. `gctrl board score BACK-42 --name quality --value 0.9`.
  2. **Auto** — computed from CI/test results, coverage reports, cost data. Auto-scored on issue completion.
  3. **Model** — LLM-as-judge evaluation. Run a model evaluator against the agent's output to score specific dimensions.
- **Score lifecycle** — scores accumulate per issue. Multiple scores per dimension are allowed (e.g., different reviewers). Aggregate views (mean, trend) are computed at query time.
- **Eval dashboard** — per-project view of score distributions over time, by dimension, by agent, by prompt version. Answers "are agents getting better?" and "which prompt version produces the best work?"

Data source: kernel `eval_scores` table (target_type = 'session' or 'task', linked to issue via session→issue mapping).

### Prompt Analytics

Track which prompt versions correlate with good outcomes.

- **Prompt version history** — for each `WORKFLOW.md` or dispatch template, see all versions (from `prompt_versions`), when each was used, and which issues used which version.
- **Version comparison** — compare two prompt versions side-by-side. Show score distributions for issues worked under each version. Identify which changes improved or degraded quality.
- **Prompt→score correlation** — scatter plot of prompt version vs. eval scores. Surface prompt changes that had statistically significant impact on quality.

Data source: kernel `prompt_versions`, `session_prompts`, `eval_scores` tables.

### External Sync (via Drivers)

- `driver-github`: Bidirectional sync with GitHub Issues
- `driver-linear`: Bidirectional sync with Linear

## Roadmap

### Shipped

| Feature | Description | Status |
|---------|-------------|--------|
| Board storage | 4 DuckDB tables, full CRUD, 44 Rust tests | Shipped |
| Status lifecycle | Forward-only transitions with validation, auto-events | Shipped |
| HTTP API | 9 endpoints for projects, issues, events, comments | Shipped |
| CLI commands | 8 `gctrl board` subcommands | Shipped |
| Effect-TS schemas | Issue, Board, Project, IssueEvent, Comment schemas | Shipped |
| BoardServiceLive | Effect-TS adapter backed by kernel HTTP API, 10 tests | Shipped |
| Session linking | Link sessions to issues, accumulate cost/tokens | Shipped |

### Next

| Feature | Priority | Issue |
|---------|----------|-------|
| **Web UI: Kanban board** — drag-and-drop columns, issue cards, detail panel | P0 | TBD |
| **Web UI: Agent OTel dashboard** — cost charts, session timeline, trace explorer | P0 | TBD |
| **Web UI: App server** — gctrl-board serves its own HTTP on a distinct port, reads kernel via shell HTTP API | P0 | TBD |
| Per-issue trace explorer (`gctrl board traces`) | P0 | TBD |
| Eval scoring (web UI form + `gctrl board score` CLI) | P0 | TBD |
| Auto-scoring on issue completion (tests_pass, coverage_delta, cost_efficiency) | P0 | TBD |
| Context audit (web UI panel + `gctrl board context-audit` CLI) | P1 | TBD |
| Prompt inspection (show rendered prompt per session) | P1 | TBD |
| Eval dashboard (score trends by project, dimension, agent) | P1 | TBD |
| Dependency resolver (DependencyResolver service) | P1 | TBD |
| Auto-transitions from kernel IPC events | P1 | TBD |
| `gctrl board assign` → orchestrator dispatch | P1 | TBD |
| Board snapshot → context entry for agents | P1 | TBD |
| driver-github (bidirectional issue sync) | P1 | TBD |

### Backlog

- Real-time kanban updates via kernel IPC / SSE
- Prompt version comparison + score correlation
- Context gap detection (automated)
- Model-based eval (LLM-as-judge scoring)
- WIP limits per column (visual + enforced)
- Sprint/milestone grouping
- driver-linear
- driver-notion

## Non-Goals

- **Not a full project management tool.** No Gantt charts, time tracking, or resource allocation. Use Linear/Notion for that and sync via drivers.
- **Not a task manager for agents.** Task lifecycle is owned by the kernel Scheduler. The board reads Tasks for visualization only.
- **Not a standalone observability platform.** The board reads kernel telemetry — it does not ingest OTel traces or store spans. The kernel owns that. The board provides the per-issue lens and the visual dashboard.
- **Not a prompt engineering IDE.** The board shows prompt versions and correlates them with scores. It does not author, edit, or template prompts — that's the WORKFLOW.md file and the kernel's prompt_versions table.
- **Not a library consumed by the shell.** The shell does NOT import gctrl-board. The board is a standalone app with its own server and UI. The CLI surface (`gctrl board`) is part of the shell's command set — it calls kernel HTTP endpoints directly, not board app code.

## Success Criteria

1. `gctrl board create BACK "Fix auth"` + `gctrl board assign BACK-1 claude-code --type agent` works end-to-end via CLI.
2. **Web UI serves a kanban board** at `http://localhost:<board-port>` with drag-and-drop columns and issue cards.
3. **Web UI serves an agent OTel dashboard** with cost charts, session timelines, and trace explorer.
4. Agent session costs automatically accumulate on the linked issue (visible in both web UI and CLI).
5. Invalid status transitions are rejected with a clear error (both web UI and CLI).
6. Board data accessible via web UI, CLI, and board's own HTTP API.
7. `gctrl board traces BACK-1` shows all sessions and span trees for a completed issue within 1 second.
8. `gctrl board score BACK-1 --name quality --value 0.9` writes to `eval_scores` and is queryable in the eval dashboard (web UI).
9. `gctrl board context-audit BACK-1` shows the rendered prompt and lists context entries provided vs. referenced.
10. Auto-scores (tests_pass, coverage_delta, cost_efficiency) are computed on every issue completion without manual action.
11. **All data flows through the shell/kernel HTTP API.** See [specs/architecture/os.md — Dependency Direction](../../specs/architecture/os.md) for the full invariant.
