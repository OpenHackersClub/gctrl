# GroundCtrl — Roadmap

> Milestones and slice tables for gctrl. See [PRD.md](PRD.md) for the problem, design principles, and what we are *not* building (job queue / swarm orchestrator).
>
> **Reframe (2026-05): pivot from harness-engineering OS to AI-native team OS.** The primary user surface is **direction + in-loop improvement**, not task dispatch. The orchestrator survives as an opt-in dispatcher (M2c) but is no longer the headline of M2. See PRD.md for the full reframe.

## M1: Kernel Core — Shipped

| Feature | Description | Status |
|---------|-------------|--------|
| Telemetry | OTel receiver, session tracking, cost attribution | Shipped (123 tests) |
| Storage | DuckDB embedded, 12 tables, schema migrations | Shipped |
| Guardrails | Policy engine: budgets, loops, commands, branches | Shipped |
| Context Manager | DuckDB + filesystem store, CLI, HTTP API | Shipped |
| Net Utilities | Fetch, crawl, compact, import | Shipped |
| Analytics | Cost, latency, scores, daily trends, trace trees | Shipped |

## M2: Direction & Accumulation — In Progress

**Goal:** Humans steer agents through a durable, versioned direction surface. Every agent session starts with the right context and writes back to it. Tickets and queues are no longer the primary input.

### M2a: Direction Surface (vault-first)

The team's intent — goals, priorities, conventions, review feedback — is the first-class object. Stored in vault markdown (so non-devs and Obsidian users can edit), watched by the kernel, propagated to sessions. See the [direction example in PRD](PRD.md#direction-example) for the shape.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Direction schema | Vault frontmatter for goals / priorities / constraints / feedback; markdown body | P0 | M1 Vault watch | TBD |
| Direction watch + index | Kernel watcher hashes direction files, indexes `vault_path`+`content_hash`, fires events | P0 | M1 Vault watch | TBD |
| Direction → session injection | At session start, render relevant direction into the prompt harness | P0 | Direction schema, M1 Context Manager | TBD |
| `gctrl direct` CLI | `direct set / list / show / archive` — write direction without leaving the terminal | P0 | Direction schema | TBD |
| **Obsidian editor UX** | Direction files render and edit cleanly in Obsidian; frontmatter validation surfaces inline | **P0** | Direction schema | TBD |
| Direction propagation events | Emit `DirectionChanged` so subscribers (board, eval, drivers) react | P1 | Direction watch | TBD |
| Per-persona scoping | Direction can target persona, project, repo, or global | P1 | Direction schema, M2c Personas | TBD |

### M2b: Accumulation (every session writes back)

Sessions produce more than diffs — they produce *signal*. Insight, decision, skill, feedback. The accumulation store captures it.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Session-write-back contract | Define what a session MUST write back (insights, decisions, eval-eligible artifacts) | P0 | M1 Telemetry | TBD |
| Insight capture | Structured "what I learned" entries linked to session + spans | P0 | Session write-back contract | TBD |
| Review feedback capture | `gctrl review` — capture structured review feedback on a session/PR; persists to vault + DuckDB | P0 | Session write-back contract | TBD |
| Decision log | Append-only architectural-decision log surfaced to next session | P1 | Insight capture | TBD |
| Skill registry — scaffold | `skills` table + vault-resident skill markdown; CLI `gctrl skill list/show/score/attach` | P0 | M1 Context Manager | TBD |
| Skill extraction (manual) | Promote a successful session's pattern to a reusable skill via CLI | P1 | Skill registry | TBD |
| Skill extraction (automatic) | Heuristic + LLM-judge promotion of recurring successful patterns | P2 | Skill extraction (manual), M4 Substrate API | TBD |
| Context auto-attach | On session start, select skills + insights relevant to current direction | P1 | Skill registry, Direction → session injection | TBD |

### M2c: Personas & Team View

The team — humans and agents — is the unit of management. This is also where the **human-side pillar (affordances over queries)** is most load-bearing: M2c is the primary surface a team lead reaches for. If the views here merely dump data, the pivot fails on the human side.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Persona table + CLI | `users` table (humans + agent personas); capability grants; `gctrl persona list/create/scope` | P0 | M1 Guardrails | TBD |
| Per-persona guardrails | Cost budget, branch policy, command allowlist scoped to persona | P0 | Persona table, M1 Guardrails | TBD |
| Per-persona affordance card | `gctrl persona show <name>` — current activity, scorecard trend, scope/guardrails, recent feedback, who's directing it. Highlights items needing action (declining score, budget near cap, expired direction) | P0 | Persona table, M2b Review feedback | TBD |
| Team view (affordance-shaped) | `gctrl status --team` — direction, in-flight, blocked, cost, eval trend. **Highlights items needing action**, not a wall of raw rows. Acceptance: a lead returning after a weekend understands state + next move in one screen | P0 | M1 Analytics, Persona table, Per-persona affordance card | TBD |
| Direction affordance | `gctrl direct list` surfaces expired / orphan / conflicting direction with an obvious next move | P0 | M2a Direction schema | TBD |
| Standup view | `gctrl status --since 1d --team` — what shipped, what's stuck, what's queued | P1 | Team view | TBD |
| Retro view | `gctrl review --since 1w` — feedback patterns, eval regressions, cost outliers | P1 | Team view, Review feedback capture | TBD |

### M2d: Lightweight Dispatcher (opt-in, not the headline)

Teams that still want a queue get one. **This used to be M2's headline; in the pivot it is one optional surface among several.**

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Task table + CRUD | `tasks` table, `SchedulerPort` trait methods | P1 | M1 | TBD |
| Scheduler tokio adapter | In-process timer adapter for `schedule_once` / `schedule_recurring` | P1 | Task CRUD | TBD |
| Claim machine | Unclaimed → Claimed → Running → Released | P1 | Task CRUD | TBD |
| Dispatch eligibility | 7-condition check (slots, deps, persona resolvable, etc.) | P1 | Claim machine, Persona table | TBD |
| Agent adapter (Claude Code) | Spawn `claude` CLI with rendered prompt | P1 | Dispatch eligibility | TBD |
| Retry with backoff | Exponential backoff; continuation check on success | P2 | Agent adapter | TBD |
| Reconciliation loop | Detect stalled sessions, propagate terminal status | P2 | Claim machine | TBD |
| `gctrl orchestrate` CLI | `dispatch / list / pause / resume / status` | P2 | Claim machine | TBD |

**Done when:** A team can write direction in the vault, an agent session loads that direction + relevant skills + insights automatically, and after the session finishes a structured review writes new signal back to the vault — without anyone writing a ticket. Optionally, `gctrl orchestrate dispatch BACK-42` still works for the queue-style flow.

## M3: Sync & Team Distribution — Planned

**Goal:** AI-native team operation works across multiple developers and devices. Direction, accumulation, and eval signal are shared.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Parquet export | `COPY ... TO ... FORMAT PARQUET` for sessions, spans, scores | P0 | M1 Storage | TBD |
| R2 upload adapter | S3-compatible PUT to R2, device-partitioned paths | P0 | Parquet export | TBD |
| `gctrl sync push/pull/status` | Push unsynced rows, pull remote into local, show state | P0 | R2 upload | TBD |
| Direction vault sync | Push/pull direction markdown via R2 with conflict-aware merge | P0 | R2 upload, M2a | TBD |
| Skill registry sync | Push/pull skills with version + score | P1 | M2b Skill registry, R2 upload | TBD |
| Knowledge crawl sync | Push `spider/` crawled content to R2 | P2 | M1 Net, R2 upload | TBD |
| driver-github | Surface direction/work into GitHub Issues; pull external tickets where used | P1 | M2c Persona, M2d Dispatcher (optional) | TBD |
| driver-linear | Same for Linear | P2 | driver-github | TBD |

**Done when:** A second device pulls direction, skills, and eval scores from the first. A new team member onboards with one `gctrl sync pull`.

## M4: In-Loop Improvement & Capacity — Planned

**Goal:** Agents improve between runs from their own signal. Performance is a property of the persona, not of one-off sessions. Team capacity is forecastable from accumulated signal.

> **Scope change under the pivot.** Observe & Eval is no longer a sibling application — it is the **engine of in-loop improvement**. Eval scores, judge metrics, and structured review feedback all flow through its substrate API and into per-persona scorecards; the kernel reads from those scorecards to update the next session's harness. Its previous scope (substrate + harness runner + Langfuse-grade observability) is retained; what changes is that this work is now load-bearing for the project's headline success metric, not a future-nice-to-have. Owners of existing observe-eval work should treat M4a as the new top of their queue.

Observe & Eval owns both the **substrate** (metrics, prompts, judges, datasets, runs, score store) and the **harness** (`gctrl eval run`). See [Observe & Eval architecture](../architecture/apps/observe-eval.md).

### M4a: Closed Improvement Loop

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Eval primitives schema | `eval_metrics`, `eval_datasets`, `eval_cases`, `eval_runs`; extend `scores.target_type` for `eval_case`/`eval_run` | P0 | M1 Storage | TBD |
| Substrate API | `POST /api/eval/score / metrics / datasets / cases / runs` — apps call from their own loops | P0 | Eval primitives schema | TBD |
| Built-in judge metrics | `faithfulness`, `tool_correctness`, `json_correctness`, `hallucination`, generic `g_eval` | P0 | Substrate API, M1 LLM relay | TBD |
| Harness runner | `gctrl eval run <suite>` — thin client of the substrate API | P0 | Substrate API | TBD |
| Baseline & CI gating | `--baseline <run-id>` regression diff, non-zero exit on threshold breach | P1 | Harness runner | TBD |
| **Signal → harness update** | Eval scores + review feedback automatically update the prompt/skill harness for next session (no manual edit). **P1 until Open Question #2 is closed** — promising P0 on undesigned mechanics is how roadmaps drift. | **P1** (blocked) | Harness runner, M2b Skill registry, M2b Review feedback, Open Question #2 | TBD |
| Per-persona scorecard | Longitudinal eval + cost + outcome trend per persona | P0 | Substrate API, M2c Persona table | TBD |
| Skill score updates | Skill registry scores update from runs that used the skill | P1 | Skill registry, Substrate API | TBD |
| Prompt A/B comparison | Compare prompt versions / models against the same suite | P2 | Harness runner | TBD |
| TypeScript SDK | Thin wrapper over substrate API for embedded eval | P2 | Substrate API | TBD |

### M4b: Capacity & Direction Forecasting

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Throughput metrics | Direction-level throughput, avg cost, avg duration per persona | P1 | M2c Team view, M2b Write-back | TBD |
| Delivery forecast | Given direction + current throughput, estimate completion date | P2 | Throughput metrics | TBD |
| NL → SQL query | Natural-language → guardrailed SQL for agent self-inspection | P2 | M1 Query engine | TBD |
| Direction → board surface | Materialize direction-level work into board cards for cross-org visibility | P1 | M2a, gctrl-board | TBD |

**Done when:** A team-defined eval metric improves month-over-month from harness updates alone (no model swap, no manual prompt edit). A team lead asks "is direction X on track" and gets a forecast. An agent asks "my cost this session" and gets an answer.

## Backlog (unprioritized)

- Protobuf OTLP support (currently JSON only)
- Web dashboard (Cloudflare Pages + DuckDB WASM)
- Browser control rollout via `driver-browser` (PR2–PR6 of #148)
- Research Assistant application (semantic search over crawled docs)
- Code Review Bot application (PR review with trace + direction context)
- Incident Response application (alert triage, runbook execution)
- `gctrl spec` utility (spec audit, review, gap analysis)
- Inter-team direction sharing (cross-org direction templates)

## Open Questions

- [ ] **What is "direction" exactly?** — Lock the YAML/markdown schema in M2a. Candidate axes: goal, constraint, priority, scope, audience-persona, expiry. Needs at least one real team using it.
- [ ] **Signal → harness update mechanics** — How does a low eval score on `tool_correctness` turn into a prompt delta? Hard-coded rules? LLM-judge proposal with human approval? Required by M4a P0.
- [ ] **Skill promotion criteria** — When does a pattern become a first-class skill? Manual-only (P1) is safe; automatic (P2) needs a quality bar.
- [ ] **Persona vs. skill** — Persona = scope + guardrails; Skill = reusable how-to. Confirm the boundary holds in real use.
- [ ] **Dispatcher fallback** — Is M2d's lightweight dispatcher enough, or do teams that *want* a queue need more? Defer until at least one team complains.
- [ ] **Protobuf vs JSON-only for OTLP** — Needed by M3.
- [ ] **DuckDB WASM for Workers dashboard** — Needed by M3.
