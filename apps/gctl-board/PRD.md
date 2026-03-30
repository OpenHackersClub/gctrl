# gctl-board — Product Requirements Document

> Agent-native project management, observability, and evaluation for human+agent teams. Track issues, understand agent behavior through traces and prompts, and close the feedback loop with eval scoring.
>
> Instantiates the [PRD template](specs/workflows/prd-template.md).

## Problem

1. **No shared issue tracker between humans and agents.** Humans use Linear/GitHub Issues; agents have no native way to see, claim, or report on issues. Context is manually copy-pasted into prompts.

2. **No cost attribution per issue.** You know what a session cost, but not what an issue cost across multiple sessions and agents. There's no way to answer "how much did BACK-42 cost to complete?"

3. **No dependency management for agent work.** Agents can't express "don't start X until Y is done." There's no DAG of blocking relationships.

4. **No auto-transitions.** When an agent opens a PR, the issue should move to `in_review` automatically. When a PR merges, it should move to `done`. Today this requires manual status updates.

5. **No way to understand why an agent succeeded or failed.** The kernel captures OTel traces and prompt versions, but there's no per-issue view that shows what context the agent received, what reasoning path it took, and where it went wrong. You can see spans in isolation — you can't see the story of an issue.

6. **No context quality feedback loop.** Agents may start work with insufficient or stale context (missing specs, outdated docs, no architecture guidance). There's no systematic way to audit what context was provided vs what was needed, or to score context quality after the fact.

7. **No eval criteria for agent work.** You can review a PR, but there's no structured way to score agent work across dimensions (correctness, test coverage, spec adherence, cost efficiency), track scores over time, or correlate scores with prompt versions or context quality. No Langfuse-style evaluation pipeline.

## Our Take

**Issues are the human-managed unit of work. Tasks are the agent-managed unit. The board shows both — and shows *how* the agent worked, not just *that* it worked.**

Humans create, prioritize, and assign Issues. Agents create Tasks via the kernel Scheduler. The board visualizes Tasks read-only under their linked Issue. The kernel's telemetry automatically links sessions to issues and accumulates cost/tokens.

The board is also the place where humans understand and evaluate agent behavior. For every issue, you can see the full trace (what the agent did), the prompts it received (what context it had), and score the result (how well it did). This closes the harness engineering feedback loop: observe behavior → evaluate quality → improve context and prompts → observe again.

The kernel owns the raw data (`sessions`, `spans`, `prompt_versions`, `eval_scores`). The board owns the per-issue view that ties them together into an actionable picture.

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

| Need | Solution |
|------|----------|
| "Create an issue for agent work" | `gctl board create BACK "Fix auth bug"` |
| "Assign it to an agent" | `gctl board assign BACK-1 claude-code --type agent` |
| "See what's in progress" | `gctl board list --status in_progress` |
| "How much did this issue cost?" | `gctl board show BACK-1` (shows accumulated cost) |
| "Move to review after PR" | Auto-transition on PR open |
| "What did the agent actually do on this issue?" | `gctl board traces BACK-1` — per-issue trace explorer |
| "Did the agent have the right context?" | `gctl board context-audit BACK-1` — shows prompts, docs, specs provided |
| "Score this agent's work" | `gctl board score BACK-1 --name quality --value 0.8 --comment "Good but missed edge case"` |

### Secondary: Team Lead Reviewing Agent Output and Improving Harness

| Need | Solution |
|------|----------|
| "What did agents work on this week?" | `gctl board list --assignee-type agent --format json` |
| "Which issues are blocked?" | `gctl board list --status backlog` + check `blocked_by` |
| "Total agent spend on this project" | `gctl board list --project BACK --format json` + sum costs |
| "Are agents getting better over time?" | `gctl board eval-dashboard --project BACK` — score trends by dimension |
| "Which prompt version produces the best results?" | `gctl board prompt-stats --project BACK` — scores correlated with prompt versions |
| "Where are the context gaps?" | `gctl board context-gaps --project BACK` — issues where context was rated insufficient |

## Use Cases

### 1. Issue-to-Agent Dispatch

**Problem:** Manually writing prompts for each agent task.
**Solution:** `gctl board assign BACK-42 --agent claude-code` creates a Scheduler Task, the orchestrator dispatches a session, telemetry links back to the issue.
**Metric:** Zero manual prompt construction for dispatched issues.

### 2. Cost Transparency Per Issue

**Problem:** Can't attribute agent costs to specific work items.
**Solution:** Session→Issue linking via telemetry. Every session that references `BACK-42` adds its cost/tokens to the issue.
**Metric:** 100% of dispatched sessions linked to their issue within 30 seconds.

### 3. Dependency-Aware Scheduling

**Problem:** Agents start work on issues that depend on unfinished prerequisites.
**Solution:** `gctl board block BACK-5 --by BACK-3` creates a DAG edge. The orchestrator won't dispatch BACK-5 until BACK-3 is done.
**Metric:** Zero dispatches to blocked issues.

### 4. Per-Issue Agent Behavior Understanding

**Problem:** An agent completed BACK-42 but the PR has subtle issues. You want to understand what happened — what context it had, what reasoning path it took, where it went wrong.
**Solution:** `gctl board traces BACK-42` shows all sessions and spans for the issue in a trace tree. Each session links to the prompt version used. You can see the agent's tool calls, LLM interactions, errors, and retries — all scoped to the one issue.
**Metric:** Time-to-diagnose agent failure < 2 minutes (vs. manually searching through logs).

### 5. Context Quality Audit

**Problem:** Agent failed on BACK-42 because it didn't know about the rate limiting middleware. The architecture doc existed but wasn't included in the prompt context. There's no systematic way to identify these gaps.
**Solution:** `gctl board context-audit BACK-42` shows what was provided (prompt content, linked docs, context entries) alongside what the agent referenced or asked about during the session. Gaps are surfaced as missing references.
**Metric:** Context gap detection per issue — "agent referenced X but X was not in provided context."

### 6. Eval Criteria and Scoring (Langfuse-style)

**Problem:** PR review is the only feedback mechanism. There's no way to score agent work across structured dimensions, track quality trends, or correlate scores with prompt or context changes.
**Solution:** Define eval criteria per project (e.g., `quality`, `tests_pass`, `spec_adherence`, `cost_efficiency`). Score each issue from multiple sources: human review, automated checks (test results, coverage delta), model-based evaluation. Scores are stored in the kernel's `eval_scores` table and queryable per issue, per project, over time.
**Metric:** Every completed issue has at least one score within 24 hours. Score trends visible per project per week.

## What We're Building

### Issue CRUD + Kanban Lifecycle

- Projects with auto-incrementing keys (`BACK-1`, `BACK-2`)
- Issue creation, listing, detail view
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
  1. **Human** — manual scores from PR review or Show & Tell. `gctl board score BACK-42 --name quality --value 0.9`.
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
| CLI commands | 8 `gctl board` subcommands | Shipped |
| Effect-TS schemas | Issue, Board, Project, IssueEvent, Comment schemas | Shipped |
| BoardServiceLive | Effect-TS adapter backed by kernel HTTP API, 10 tests | Shipped |
| Session linking | Link sessions to issues, accumulate cost/tokens | Shipped |

### Next

| Feature | Priority | Issue |
|---------|----------|-------|
| Per-issue trace explorer (`gctl board traces`) | P0 | TBD |
| Eval scoring CLI (`gctl board score`) | P0 | TBD |
| Auto-scoring on issue completion (tests_pass, coverage_delta, cost_efficiency) | P0 | TBD |
| Context audit (`gctl board context-audit`) | P1 | TBD |
| Prompt inspection (show rendered prompt per session) | P1 | TBD |
| Eval dashboard (score trends by project, dimension, agent) | P1 | TBD |
| Dependency resolver (DependencyResolver service) | P1 | TBD |
| Auto-transitions from kernel IPC events | P1 | TBD |
| `gctl board assign` → orchestrator dispatch | P1 | TBD |
| Board snapshot → context entry for agents | P1 | TBD |
| driver-github (bidirectional issue sync) | P1 | TBD |

### Backlog

- Prompt version comparison + score correlation
- Context gap detection (automated)
- Model-based eval (LLM-as-judge scoring)
- Kanban web UI (Effect Platform + HTMX)
- WIP limits per column
- Sprint/milestone grouping
- driver-linear
- driver-notion

## Non-Goals

- **Not a full project management tool.** No Gantt charts, time tracking, or resource allocation. Use Linear/Notion for that and sync via drivers.
- **Not a task manager for agents.** Task lifecycle is owned by the kernel Scheduler. The board reads Tasks for visualization only.
- **Not a standalone observability platform.** The board reads kernel telemetry — it does not ingest OTel traces or store spans. The kernel owns that. The board provides the per-issue lens.
- **Not a prompt engineering IDE.** The board shows prompt versions and correlates them with scores. It does not author, edit, or template prompts — that's the WORKFLOW.md file and the kernel's prompt_versions table.

## Success Criteria

1. `gctl board create BACK "Fix auth"` + `gctl board assign BACK-1 claude-code --type agent` works end-to-end.
2. Agent session costs automatically accumulate on the linked issue.
3. Invalid status transitions are rejected with a clear error.
4. Board data accessible via both CLI and HTTP API.
5. `gctl board traces BACK-1` shows all sessions and span trees for a completed issue within 1 second.
6. `gctl board score BACK-1 --name quality --value 0.9` writes to `eval_scores` and is queryable in the eval dashboard.
7. `gctl board context-audit BACK-1` shows the rendered prompt and lists context entries provided vs. referenced.
8. Auto-scores (tests_pass, coverage_delta, cost_efficiency) are computed on every issue completion without manual action.
