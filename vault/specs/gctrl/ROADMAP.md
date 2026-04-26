# GroundCtrl — Roadmap

> Milestones and task breakdown for gctrl. See [PRD.md](PRD.md) for the problem, goals, and design principles.

## M1: Kernel Core — Shipped

| Feature | Description | Status |
|---------|-------------|--------|
| Telemetry | OTel receiver, session tracking, cost attribution | Shipped (123 tests) |
| Storage | DuckDB embedded, 12 tables, schema migrations | Shipped |
| Guardrails | Policy engine: budgets, loops, commands, branches | Shipped |
| Context Manager | DuckDB + filesystem store, CLI, HTTP API | Shipped |
| Net Utilities | Fetch, crawl, compact, import | Shipped |
| Analytics | Cost, latency, scores, daily trends, trace trees | Shipped |

## M2: Orchestration & Board — In Progress

**Goal:** Agents autonomously pick up issues, execute work, and report results via the board.

### M2a: gctrl-board Core (Effect-TS)

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Board DuckDB adapter | Effect-TS adapter that writes to `board_*` tables via HTTP API | P0 | M1 | TBD |
| Issue CRUD service | `BoardService.createIssue`, `moveIssue`, `listIssues`, `getIssue` | P0 | Board DuckDB adapter | TBD |
| Issue status lifecycle | Enforce kanban transitions (backlog→todo→in_progress→in_review→done) with side-effect validation | P0 | Issue CRUD | TBD |
| Dependency resolver | `DependencyResolver` service — add/remove edges, cycle detection, auto-unblock | P1 | Issue CRUD | TBD |
| Board CLI bridge | Rust CLI delegates `gctrl board *` to Effect-TS service via HTTP | P0 | Issue CRUD | TBD |
| Board HTTP routes | `/api/board/issues`, `/api/board/projects` mounted on Rust daemon | P0 | Board CLI bridge | TBD |

### M2b: Scheduler & Orchestrator (Rust)

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Task table + CRUD | Implement `tasks` table in DuckDB, `SchedulerPort` trait methods | P0 | M1 | TBD |
| User/persona table | Implement `users` table, `UserKind`, capability grants | P0 | M1 | TBD |
| Scheduler tokio adapter | In-process timer adapter for `schedule_once`/`schedule_recurring` | P1 | Task CRUD | TBD |
| Orchestrator claim machine | Implement Unclaimed→Claimed→Running→Released state machine in Rust | P0 | Task CRUD | TBD |
| Dispatch eligibility | 7-condition check: task exists, not terminal, not claimed, slots available, deps met, user resolvable | P0 | Claim machine, User table | TBD |
| Agent adapter (Claude Code) | Spawn `claude` CLI with rendered prompt, capture exit code | P0 | Dispatch eligibility | TBD |
| Retry with backoff | Exponential backoff on failure, continuation check on success | P1 | Agent adapter | TBD |
| Reconciliation loop | Detect stalled sessions, validate scheduler state, propagate terminal status | P1 | Claim machine | TBD |
| `gctrl orchestrate` CLI | `dispatch`, `list`, `pause`, `resume`, `status` subcommands | P0 | Claim machine | TBD |

### M2c: Board ↔ Kernel Integration

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Session→Issue linking | Auto-link session to issue when span references issue key | P1 | M2a Issue CRUD, M1 Telemetry | TBD |
| Cost accumulation | Roll up session cost/tokens to linked issue | P1 | Session→Issue linking | TBD |
| Auto-transitions | Issue moves to `in_progress` on first session, `in_review` on PR open | P1 | Session→Issue linking | TBD |
| Agent assignment | `gctrl board assign BACK-42 --agent claude-code` → creates task, dispatches | P1 | M2b Orchestrator, M2a Board | TBD |

**Done when:** `gctrl board assign BACK-42 --agent claude-code` creates a task, the orchestrator dispatches a Claude Code session, telemetry links back to the issue, and cost accumulates.

## M3: Sync & Team — Planned

**Goal:** Multiple developers share telemetry and context across devices.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Parquet export | `COPY ... TO ... FORMAT PARQUET` for sessions, spans, traffic tables | P0 | M1 Storage | TBD |
| R2 upload adapter | S3-compatible PUT to Cloudflare R2, device-partitioned paths | P0 | Parquet export | TBD |
| `gctrl sync push` | CLI command to push unsynced rows, mark `synced=true` | P0 | R2 upload | TBD |
| `gctrl sync pull` | Download remote Parquet into local DuckDB | P1 | R2 upload | TBD |
| `gctrl sync status` | Show sync state — pending rows, last push, R2 bucket | P0 | Parquet export | TBD |
| Context push/pull | Push `~/.local/share/gctrl/context/` to R2 `knowledge/context/`, pull to local | P1 | M1 Context Manager, R2 upload | TBD |
| Knowledge crawl sync | Push `spider/` crawled content to R2 `knowledge/crawls/` | P2 | M1 Net, R2 upload | TBD |
| driver-github | Bidirectional issue sync with GitHub Issues via `TrackerPort` | P1 | M2a Board | TBD |
| driver-linear | Bidirectional issue sync with Linear via `TrackerPort` | P2 | M2a Board | TBD |

**Done when:** `gctrl sync push && gctrl sync pull` on a second device shows the first device's sessions and context.

## M4: Eval, Capacity & Intelligence — Planned

**Goal:** Agents understand their own performance; teams can forecast delivery.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Eval scoring pipeline | Configurable auto-scoring rules beyond `auto-score` (custom evaluators) | P1 | M1 Scoring | TBD |
| Prompt A/B comparison | Compare prompt versions by score distributions | P2 | Eval scoring, M1 Prompt versions | TBD |
| Throughput metrics | Issues closed/week, avg cost/issue, avg duration/issue by agent | P1 | M2c Cost accumulation | TBD |
| Delivery forecast | Given open issues + throughput, estimate completion date | P2 | Throughput metrics | TBD |
| NL→SQL query interface | Natural language → guardrailed SQL for agent self-inspection | P2 | M1 Query engine | TBD |
| Board snapshots | `gctrl board snapshot` → markdown context entry for agent consumption | P1 | M2a Board, M1 Context Manager | TBD |

**Done when:** An agent can run `gctrl query "my cost this session"` and get an answer. A team lead can run `gctrl capacity forecast --milestone v2` and get a date estimate.

## Backlog (unprioritized)

- Protobuf OTLP support (currently JSON only)
- Web dashboard (Cloudflare Pages + DuckDB WASM)
- Browser control (CDP daemon with ref system)
- Research Assistant application (semantic search over crawled docs)
- Code Review Bot application (PR review with trace context)
- Incident Response application (alert triage, runbook execution)
- `gctrl spec` utility (spec audit, review, gap analysis)

## Open Questions

- [ ] Protobuf vs JSON-only for OTLP ingestion — needed by M3
- [ ] DuckDB WASM for Cloudflare Workers dashboard — needed by M3
- [ ] Scheduler adapter selection (launchd vs cron vs DO Alarms) — needed by M2
