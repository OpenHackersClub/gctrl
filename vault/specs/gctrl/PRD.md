# GroundCtrl — Product Requirements Document

> The operating system for AI-native teams. Humans set direction and review outcomes. Agents pick up the work, learn from their own runs, and get better — like employees, not like job-queue workers.
>
> Instantiates the [PRD template](../../apps/gctrl-board/vault/specs/workflows/prd-template.md) for gctrl itself.

## The Problem

The first wave of agent tooling treated agents as **task queue workers**: a human writes a ticket, a dispatcher hands it to an agent, the agent shells out a diff, the human reviews. Symphony, OMC's team pipeline, and most CI-integrated coding agents share that shape. It works — but it caps the team at "human typing speed" and the agent never gets smarter between runs.

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

| Job-runner OS (the world we left) | AI-native team OS (gctrl) |
|---|---|
| Human writes ticket → dispatcher → agent runs → human reviews | Human sets direction → agents pick up work → agents learn → humans review outcomes, not output |
| Agent is a stateless function | Agent is a long-lived employee with reputation, skills, and history |
| Improvement happens out-of-band (humans edit prompts) | Improvement is in-loop: traces, evals, and review feedback update agent context automatically |
| The unit of management is the *task* | The unit of management is the *agent's direction and growth* |
| Telemetry is for blame and billing | Telemetry is for learning — what worked, what didn't, why |

**The kernel is small and always present.** `gctrl serve` gives a solo developer their own AI-native team in one command — telemetry, storage, guardrails, vault, and the direction surface. No config, no cloud, no Docker.

**Direction is the primary input.** Tickets, queues, and dispatchers still exist where they're useful (gctrl-board, driver-github), but they are *outputs* of direction, not the input. The team writes intent; the kernel materializes work.

**Agents close their own loop.** Observe & Eval captures performance signal; the context manager owns shared skill/knowledge; review feedback is structured and replayable. The kernel doesn't train models — it curates the *harness* (context, prompts, skills, scope) that determines how agents perform, and updates that harness from outcomes.

**Humans review outcomes, not output.** Guardrails handle the operational concerns. The human role shifts from "approve every diff" to "set direction, watch trends, intervene on the things only a human can decide."

**Local-first, cloud-optional.** Everything works offline. Cloud sync layers on for team visibility. Data is Parquet and markdown — no lock-in.

**Adapt, don't replace.** Connect to Linear, GitHub, Notion, Obsidian, Phoenix via drivers. gctrl is the team's OS layer, not a workflow replacement.

## Design Principles

1. **Direction over dispatch.** The primary user surface is *direction* (intent, goals, priorities, feedback) — not task assignment. Features that require humans to pre-decompose work into tickets MUST be optional, not the happy path.
2. **Agents accumulate.** Every agent session MUST write back to a durable, shared context (vault, skills, eval scores, structured review feedback). A session that produces output without producing context is a missed compounding step.
3. **Improvement is in-loop, not out-of-band.** Performance signal (eval scores, review feedback, run outcomes) MUST flow back into the agent harness (prompts, skills, scope) without manual prompt-editing rituals. Out-of-band improvement is a fallback, not the design.
4. **Humans review outcomes, not output.** The kernel SHOULD let humans approve direction, watch trends, and intervene on judgment calls — not stamp every PR. Features that force humans to be in the inner loop of every action are anti-goals.
5. **The team is a first-class object.** Cost, throughput, work-in-flight, skill coverage are properties of the *team*, not aggregations a human computes from sessions. Team-level views are part of the kernel surface, not a future BI tool.
6. **Context is infrastructure, not manual labor.** Conventions, docs, past decisions, replayable feedback — the harness MUST deliver these to every session automatically.
7. **Usable out of the box by one person.** `cargo install gctrl && gctrl serve` — a solo developer running one agent gets the full loop: direction, accumulation, in-loop improvement, review.
8. **Small kernel, optional everything else.** Direction surface, accumulation store, and observation are kernel concerns. Specific applications (board, eval-runner, capacity engine) are optional defaults.
9. **OS layer is stable; applications evolve fast.** Telemetry format, vault schema, port surface change rarely. Applications ship and iterate independently.
10. **Agents are first-class consumers.** Every feature is CLI/API-first and automatable. Agents drive gctrl as much as humans do.
11. **Local-first, cloud-optional.** Kernel works fully offline. Cloud sync is opt-in.
12. **Adapt, don't replace.** Connect to existing tools via drivers. Shipped applications are defaults, not mandates.

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

**Direction Surface** — The primary input. Vault-resident, watched, versioned. Intent, goals, priorities, conventions, review feedback all live here. The kernel propagates direction to agent sessions automatically; it does not require pre-decomposed tickets.

**Telemetry** — The `/proc` of agent work. OpenTelemetry ingestion, session tracking, cost attribution. Every operation is observable.

**Accumulation Store (Storage + Context + Vault)** — The filesystem and the team memory. DuckDB for structured signal (sessions, spans, scores, runs). Filesystem-resident vault for human-readable direction, decisions, and skills. Markdown + Parquet — no lock-in.

**Guardrails** — The `ulimit` + `cgroups`. Cost budgets, loop detection, command allowlists, branch protection. Attached to personas, applied per session.

**Observation & Feedback Loop** — The closed loop. Observe & Eval captures performance signal (eval scores, judge metrics, review feedback); the kernel feeds that signal back into the harness (prompts, skill selection, scope, retry policy). Improvement happens in-loop.

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

**Observe & Eval** — Lifecycle eval substrate and harness. Captures performance signal across dev → CI → staging → prod on one set of primitives. Powers the in-loop improvement: eval scores and judge metrics feed back into agent harness. Also delivers Langfuse-grade local observability. See [Observe & Eval architecture](../architecture/apps/observe-eval.md).

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

**Problem:** A 3-human, 30-agent team can't ticket-decompose fast enough to keep agents fed. Tickets that *do* exist are stale by the time agents pick them up.

**Solution:** Direction vault is the primary input. A goal like "improve onboarding conversion" or a constraint like "no new dependencies this sprint" propagates to every session. Agents materialize concrete work from direction + current state; humans steer at the level they actually think at.

**Metric:** ≥70% of agent sessions start from direction, not from a hand-written ticket, within 30 days of adoption.

### 2. In-Loop Agent Improvement

**Problem:** Agent quality plateaus because improvement happens out-of-band — a human notices a recurring failure and edits a prompt three days later. Most failures never get noticed.

**Solution:** Observe & Eval scores every run on team-defined metrics; review feedback is captured structurally; the kernel feeds both back into harness updates (prompt deltas, skill attachment, scope changes) on the next session. The loop is closed without a human prompt-editing ritual.

**Metric:** Measurable improvement on team-defined eval metrics month-over-month. Reduction in repeated-failure patterns by ≥50% within 60 days.

### 3. Team-Level Visibility

**Problem:** Standups, retros, and capacity planning are blind to agent work. "What did the team ship this week" requires a human to manually aggregate session logs.

**Solution:** Team view rolls up direction, work-in-flight, cost, eval trends, and review feedback. Standup = `gctrl status --team`. Retro = `gctrl review --since 1w`.

**Metric:** Team retros and standups operate from gctrl team view without manual aggregation, within 30 days.

### 4. Durable Team Context

**Problem:** Every agent session starts cold. Yesterday's insight is lost.

**Solution:** Context manager + vault store conventions, decisions, skills, and review feedback. Every session loads relevant context automatically. Skill registry promotes reusable patterns to first-class, scored, versioned units.

**Metric:** "Why did we decide X?" / "How do we do Y here?" questions answered from context, not from a human, in ≥80% of cases.

### 5. Performance Management of Agents

**Problem:** When an agent underperforms, the team has no structured signal and no process. Underperformance compounds silently.

**Solution:** Eval scores, run outcomes, and review feedback form a per-persona performance record. Personas with declining metrics get scoped down, retrained (harness updates), or replaced. Like a human employee, with structured signal.

**Metric:** Per-persona eval trends are reviewable. Scope changes are driven by signal, not by gut feel.

### 6. Local-First, Privacy-Preserving Observability

**Problem:** Cloud LLM observability (Langfuse, Phoenix) requires sending prompts and completions to a third party. Non-starter for security-conscious teams.

**Solution:** Full local observability in DuckDB. Cost analytics, latency percentiles, scoring, prompt versioning. Data never leaves the machine unless the team explicitly syncs.

**Metric:** Parity with Langfuse core (traces, scores, cost, prompt mgmt) at zero data-transfer cost.

### 7. Safe Defaults for Long-Lived Autonomy

**Problem:** Agents running unattended over hours/days can burn through budget, force-push to main, or loop on a bad assumption.

**Solution:** Guardrails are persona-scoped: cost budgets, branch protection, command allowlists, loop detection. Detection-to-halt latency under 30 seconds.

**Metric:** Zero unreviewed destructive ops. Budget overruns halted in <30s.

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

1. **One-command bootstrap** — a developer can install gctrl, run `gctrl serve`, write direction in the vault, and have the next agent session pick it up — in under 5 minutes.
2. **Direction-driven work** — ≥70% of sessions on an established gctrl team start from direction, not from a hand-written ticket.
3. **In-loop improvement is real** — team-defined eval metrics show measurable improvement month-over-month from harness updates alone (no model swaps).
4. **Team is legible** — a team lead can answer "what is the team working on, what's stuck, what's the trend, where is cost going" in one CLI call.
5. **Cost and safety guardrails work** — destructive ops blocked or halted, budget overruns caught in <30s.
6. **Context compounds** — agent "why" / "how" questions answered from accumulated vault context, not from humans, in ≥80% of cases.

---

*For architecture details, see [../../architecture/](../../architecture/). For implementation details, see [../../implementation/](../../implementation/).*
