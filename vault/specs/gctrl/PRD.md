# GroundCtrl — Product Requirements Document

> The operating system for AI-native teams. Humans set direction and review outcomes. Agents pick up the work, learn from their own runs, and get better — like employees, not like job-queue workers.
>
> Instantiates the [PRD template](../../apps/gctrl-board/vault/specs/workflows/prd-template.md) for gctrl itself.

## The Problem

The dominant shape in agent tooling today is **issue-driven dispatch**: a human writes (or imports) a ticket, a runner picks it up, an agent ships a diff, the human reviews. Symphony, OMC's team pipeline, and CI-integrated coding agents are well-designed instances of that shape — and for "I have a backlog, please grind it down" they are the right tool. The shape stops working when the team has *more* agent capacity than a human can ticket-decompose, and when the agents involved would otherwise have learned from yesterday's session but don't.

Teams trying to actually live with agents day-to-day run into a different set of problems:

1. **Direction is bottlenecked on tickets.** Real work isn't a ticket — it's "ship this product line", "keep the build green this week", "investigate this regression". Tickets are an artifact humans write *for* dispatchers, not the natural unit of direction. Agents that need a fully-specified ticket to start can only consume what a human has the bandwidth to write.

2. **Agents don't accumulate.** Every session starts cold. Yesterday's debugging insights, last week's "we tried X and it failed because Y", the convention the reviewer pushed back on three PRs ago — none of it carries forward. The agent is fluent; the *team's agent* is amnesiac.

3. **No performance loop.** When a human employee underperforms, you have signal (review feedback, missed goals, peer comments) and a process (1:1s, written feedback, change of scope). For agents the team has *neither* the signal in a structured form nor a process to act on it. Bad runs go in the trash; good runs go un-mined.

4. **Steering is ad-hoc.** "Stop doing X", "do more Y", "this PR template is wrong" lives in Slack threads, scattered CLAUDE.md edits, and one-off prompt tweaks. There's no shared, durable surface where the team's direction to agents is the artifact — versioned, reviewable, and applied uniformly.

5. **No visibility on the team as a team.** You can read one session's trace. You cannot ask "what is the team working on this week, what's stuck, where is cost going, which directions are paying off." Agent work is invisible to the *team's* operating cadence — standups, reviews, retros.

6. **Tool sprawl.** Observability (Langfuse), tracking (Linear), knowledge (Obsidian), infra (AWS/Cloudflare) — each siloed. Agents can't reason across them. The human cost of stitching them is the team's biggest hidden tax.

These compound: without a durable steering surface you can't accumulate context; without accumulated context agents don't improve; without improvement humans stay in the dispatcher seat instead of doing the deep-thinking work that's actually scarce.

## Our Take: An OS for AI-Native Teams

**The bottleneck is not agent capability and it is not dispatch latency — it is the team operating model.** A team in 2026 has 3 humans and 30 agent sessions in flight; treating those 30 sessions as a job queue under-uses them and burns out the humans. The right shape is closer to **a team where humans manage and agents are employees**: humans set direction, agents own the work, both sides learn over time.

gctrl is the operating system for that team. It is **not** an issue-task dispatcher. It is **not** a swarm orchestrator. It is the layer that lets a team:

- **Give direction at the level the team actually thinks at** — strategic intent, product cuts, "do more of this, less of that" — not pre-decomposed tickets.
- **Make agents accumulate** — every session writes back to a shared, durable context. Yesterday's insight is tomorrow's prompt.
- **Run a performance loop** — eval, trace, review feedback, and human signal feed a closed loop that updates agent prompts, skills, and scope automatically.
- **See and steer the team** — the team's work is a first-class object, not a sum of disconnected sessions.

We keep the Unix metaphor because it's the right one — a small kernel, composable utilities, agents as first-class shell users — but the *load* on that OS is fundamentally different from a job-runner OS.

| Issue-driven dispatch (Symphony-shaped) | AI-native team OS (gctrl) |
|---|---|
| Ticket → dispatcher → agent runs → human reviews | Direction → agents pick up work → agents learn → humans review outcomes |
| Agent is a stateless function | Persona is long-lived, scoped, scored |
| Improvement happens out-of-band (humans edit prompts) | Improvement is in-loop: eval + review feedback update the harness automatically |
| Unit of management is the *task* | Unit of management is the *persona's direction and growth* |
| Telemetry is for billing / blame | Telemetry is for learning — what worked, what didn't, why |

Both shapes are legitimate. The pivot is not "Symphony is wrong"; it is "we're optimizing for a different operating model and shouldn't keep packaging ourselves as a broader Symphony."

**The kernel is small and always present.** `gctrl serve` gives a solo developer their own AI-native team in one command — telemetry, storage, guardrails, vault, and the direction surface. No config, no cloud, no Docker.

**Direction is the primary input.** Tickets, queues, and dispatchers still exist where they're useful (gctrl-board, driver-github), but they are *outputs* of direction, not the input. The team writes intent; the kernel materializes work.

**Agents close their own loop.** Observe & Eval captures performance signal; the context manager owns shared skill/knowledge; review feedback is structured and replayable. The kernel doesn't train models — it curates the *harness* (context, prompts, skills, scope) that determines how agents perform, and updates that harness from outcomes.

**Humans review outcomes, not output.** Guardrails handle the operational concerns. The human role shifts from "approve every diff" to "set direction, watch trends, intervene on the things only a human can decide."

**Local-first, cloud-optional.** Everything works offline. Cloud sync layers on for team visibility. Data is Parquet and markdown — no lock-in.

**Adapt, don't replace.** Connect to Linear, GitHub, Notion, Obsidian, Phoenix via drivers. gctrl is the team's OS layer, not a workflow replacement.

## Design Principles

The pivot-specific invariants (direction-as-input, write-back, in-loop improvement, harness-not-model, personas-as-employees, team-as-first-class-object) live in [principles.md → AI-Native Team Operation](../principles.md#ai-native-team-operation). The principles below are the cross-cutting ones that apply to every gctrl feature.

1. **Usable out of the box by one person.** `cargo install gctrl && gctrl serve` — a solo developer with one agent gets direction, write-back, observation, and guardrails immediately.
2. **Small kernel, optional everything else.** Direction surface, write-back, observation, and guardrails are kernel concerns. Applications (board, eval-runner, capacity engine) are optional defaults.
3. **OS layer is stable; applications evolve fast.** Telemetry format, vault schema, port surface change rarely. Applications ship and iterate independently.
4. **Agents are first-class consumers.** Every feature is CLI/API-first and automatable. Agents drive gctrl as much as humans do.
5. **Local-first, cloud-optional.** Kernel works fully offline. Cloud sync is opt-in.
6. **Adapt, don't replace.** Connect to existing tools via drivers. Shipped applications are defaults, not mandates.

## Target Users

### Primary: Developer Living With Agents

A developer (solo or in a small team) whose day is a mix of their own work and 5–30 agent sessions. They are past the "what is an agent" stage; they want their agents to *get better* and to spend less of their day in the dispatcher seat.

**What they get on day one:**

| Need | What They Use |
|------|-------------|
| "Let me write team direction once and have every agent pick it up" | Direction vault (CLAUDE.md / AGENTS.md / WORKFLOW.md, watched + propagated) |
| "Don't make me write a ticket for every little thing" | Intent → work expansion (board issues optional; agents start from goals) |
| "Carry insights and decisions across sessions" | Context manager + vault, watched and synced |
| "Show me what the agent did, what it cost, what worked" | Telemetry + analytics + Observe & Eval |
| "Prevent agents from doing destructive things" | Guardrails |
| "Score agent runs and feed that back into their prompts" | Observe & Eval + skill registry |
| "When I tell an agent 'don't do X', remember it" | Review-feedback capture → context surface |

### Secondary: AI-Native Team (2–10 humans, 10–100 agent sessions/day)

A team that already runs more agent work than human work. They need the *team* to be legible — not just individual sessions.

**Added value (drivers + sync as needed):**

| Need | What They Use |
|------|-------------|
| "Show me the team's work this week — what's in flight, stuck, done" | Team view (board + telemetry roll-up) |
| "Make agent skill/context shared across the team" | Vault sync (R2) + skill registry |
| "Trend our agents' eval scores — are they improving?" | Observe & Eval longitudinal view |
| "Sync to Linear / GitHub Issues for cross-team visibility" | driver-linear, driver-github |
| "Forecast whether direction X is on track" | Capacity Engine (throughput + direction tracking) |
| "Standardize agent harness across the team" | Direction vault + skill registry, versioned |
| "Local Langfuse — never send prompts off-laptop" | Observe & Eval (local-first observability) |

## What We're Building

### The Kernel (Always Present)

Five core primitives every AI-native team needs:

**Direction Surface** — The primary input. Vault-resident, watched, versioned. Intent, goals, priorities, conventions, and review feedback live here as markdown with frontmatter. The kernel propagates direction to agent sessions automatically; it does not require pre-decomposed tickets. See the [direction example](#direction-example) below for the shape.

**Telemetry** — The `/proc` of agent work. OpenTelemetry ingestion, session tracking, cost attribution.

**Storage + Vault** — DuckDB for structured signal (sessions, spans, scores, eval runs); filesystem-resident vault for human-readable direction, decisions, and skills. Markdown + Parquet — no lock-in. The vault is the team memory; the DB is the index.

**Guardrails** — The `ulimit` + `cgroups`. Cost budgets, loop detection, command allowlists, branch protection. Attached to personas, applied per session.

**Feedback Loop** — Observe & Eval captures performance signal (eval scores, judge metrics, review feedback); the kernel feeds that signal back into the harness (prompts, skill selection, scope, retry policy) on the next session.

### Direction Example

A `direction.md` in the vault looks like:

```markdown
---
id: dir-2026-q2-onboarding
kind: goal
scope: { project: gctrl-board, persona: "*" }
priority: high
expires: 2026-06-30
---

Improve first-session retention for new users of gctrl-board.

**What "good" looks like:** A user who runs `gctrl serve` for the
first time can create their first issue, assign an agent, and see a
session start in <5 minutes, without reading the README.

**Out of scope:** Visual redesign, mobile.

**Avoid:** Adding new dependencies. Touching the kanban schema.
```

Direction files are markdown so non-developers can edit them in Obsidian; the frontmatter is the machine-readable contract the kernel reads. See [ROADMAP M2a](ROADMAP.md#m2a-direction-surface-vault-first) for the slice plan locking the schema.

### Kernel Extensions (Optional)

| Extension | What It Solves |
|-----------|---------------|
| **Skill Registry** | Reusable agent skills extracted from successful runs. Versioned, scored, attachable to personas. The unit of accumulated capability. |
| **Scheduler** | Deferred and recurring work — review cadences, eval runs, sync. tokio (local) / launchd (macOS) / DO Alarms (Cloudflare). |
| **Lightweight Dispatcher** | For teams that still want a queue: orchestrator with retry, concurrency, dependency DAG. Opt-in. Not the primary input. |
| **Network Control** | MITM proxy for traffic visibility, domain allowlists, rate limiting. |
| **Browser Control** | CDP daemon for browser automation (`driver-browser`). |
| **Cloud Sync** | R2 Parquet for analytics, markdown sync for vault. Device-partitioned. |

### Applications (All Optional)

**gctrl-board** — A team's view of the team. Not a Jira clone. Issues exist for cross-org visibility and human-facing tracking, but the natural unit is *direction* (a goal, a priority, a thread of work). Agents materialize work from direction; humans see flow, cost, and progress at the team level.

**Observe & Eval** — Lifecycle eval substrate and harness. Under the pivot, **its role grows**: it is no longer a sibling app, it is the *engine* of in-loop improvement. Eval scores, judge metrics, and structured review feedback all flow through its substrate API and into per-persona scorecards; the kernel reads from those scorecards to update the next session's harness. Still delivers Langfuse-grade local observability as a side effect of the substrate. See [Observe & Eval architecture](../architecture/apps/observe-eval.md).

**Capacity Engine** — Direction-level throughput and forecasting. Answers "is direction X on track" — not "when will ticket Y close".

### Utilities

| Utility | What It Does |
|---------|-------------|
| `gctrl direct` | Write/edit team direction; propagate to sessions |
| `gctrl review` | Capture structured review feedback that becomes harness context next run |
| `gctrl skill list/score/attach` | Manage the skill registry |
| `gctrl net fetch / crawl / compact` | Web → markdown → context |
| `gctrl context add / list / compact` | Manage shared agent context |
| `gctrl browser goto / snapshot` | Browser automation |
| `gctrl query` | Guardrailed data access for agents |

### External App Integration (Drivers)

| Category | Apps | What the Driver Does |
|----------|------|---------------------|
| **Project Tracking** | Linear, GitHub Issues, Notion | Surface gctrl direction/work into existing trackers; pull external tickets where the team still uses them |
| **Knowledge & Docs** | Obsidian | Mount vault as Obsidian vault for human editing |
| **Observability** | Arize Phoenix, Langfuse, SigNoz | Export traces, evals, scores |
| **Agents** | Claude Code, Codex, Aider, custom | Any agent that accepts a prompt and emits OTel spans is a first-class citizen |

Zero drivers = gctrl works standalone. Add drivers as the team grows.

## Business Use Cases

### 1. Direction-First Team Operation

**Problem:** A 3-human, 30-agent team can't ticket-decompose fast enough to keep agents fed.

**Solution:** Direction vault is the primary input. A goal like "improve onboarding conversion" or a constraint like "no new dependencies this sprint" propagates to every session. Agents materialize concrete work from direction + current state.

### 2. In-Loop Agent Improvement

**Problem:** Agent quality plateaus because improvement happens out-of-band — a human notices a recurring failure and edits a prompt days later. Most failures never get noticed.

**Solution:** Observe & Eval scores every run; review feedback is captured structurally; both feed back into harness updates on the next session. No prompt-editing ritual.

### 3. Team-Level Visibility

**Problem:** Standups, retros, and capacity planning are blind to agent work.

**Solution:** Team view rolls up direction, work-in-flight, cost, eval trends, and review feedback. Standup = `gctrl status --team`. Retro = `gctrl review --since 1w`.

### 4. Performance Management of Agent Personas

**Problem:** When an agent underperforms, the team has no structured signal and no process. Underperformance compounds silently.

**Solution:** Eval scores, run outcomes, and review feedback form a per-persona performance record. Personas with declining metrics get scoped down or get harness updates — driven by signal, not by gut feel.

### 5. Local-First Observability and Safe Defaults

**Problem:** Cloud LLM observability requires sending prompts off-machine. Long-running agents can burn budget or force-push to main.

**Solution:** Full local observability in DuckDB (Langfuse-grade, zero data transfer). Persona-scoped guardrails halt budget overruns in <30s and block destructive ops.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for milestones, slice tables, and open questions.

## Non-Goals

- **Not a task dispatcher / job queue.** Symphony-style "issue → dispatch → run → exit" is a valid mode but not the primary input. We are not optimizing for shortest-path dispatch latency. Teams that want a pure dispatcher should use Symphony or a CI runner.
- **Not a swarm orchestrator.** Ruflo-style 100-agent consensus swarms are out of scope. gctrl is for small teams of capable agents, not large fleets of narrow ones.
- **Not an agent framework.** gctrl doesn't build agents — it runs the harness around them. Any agent that accepts a prompt and emits OTel spans works.
- **Not a model trainer.** "Agents improve themselves" means the *harness* improves: prompts, skills, context, scope — not model weights. The kernel curates the harness.
- **Not a replacement for Linear / GitHub / Notion.** gctrl connects to them via drivers.
- **Not a cloud platform.** Local-first. Cloud sync optional.
- **Not enterprise-first.** Individuals and small teams first. SSO/RBAC/compliance is future work.

## Success Criteria

**Headline metric (the scoreboard for the pivot):** team-defined eval scores improve month-over-month from **harness updates alone** — no model swap, no manual prompt edit. If we cannot move this number, the rest of the pivot is decoration.

Supporting criteria:

1. **One-command bootstrap** — install gctrl, `gctrl serve`, write a direction file, and the next agent session reads it. <5 minutes, cold.
2. **Team is legible in one CLI call** — `gctrl status --team` shows direction, in-flight work, cost trend, eval trend, blocked items.
3. **Guardrails work** — destructive ops blocked, budget overruns halted in <30s. (Inherited from M1; still load-bearing.)
4. **Per-persona scorecards drive scope changes** — at least one team makes a scope/harness change off a scorecard trend (not gut feel) within the first 90 days of adoption.

---

*For architecture details, see [../../architecture/](../../architecture/). For implementation details, see [../../implementation/](../../implementation/).*
