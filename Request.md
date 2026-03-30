# Request.md — Deferred Items & Open Questions

Gaps and product requirements to address in future phases.

## Phase 2: Guardrails + Proxy

- [ ] **MITM proxy integration** — Implement hudsucker-based proxy with auto-CA generation, domain allowlist, rate limiting. Requires TLS cert trust setup (macOS Keychain, Linux ca-certificates).
- [ ] **Command gateway** — Intercept shell commands before execution, enforce blocklist, require approval for destructive ops (rm -rf, git push --force).
- [ ] **Real-time guardrail hooks** — MCP-compatible hook protocol so agents can check policies before tool execution, not just after-the-fact.
- [ ] **Guardrail event persistence** — Store all policy decisions (allow/warn/deny) in guardrail_events table for audit trail.

## Phase 3: Query + Eval + Analytics (Langfuse-grade)

- [ ] **Natural language to SQL** — NL query interface with column allowlist, query rewriting, and safety guards. Requires LLM integration for SQL generation.
- [ ] **Raw SQL execution** — Gated by config flag. Needs sandboxing (read-only mode, row limits, blocked columns).
- [ ] **Eval suite engine** — Define eval suites (YAML/JSON), run against stored traces, compute pass/fail scores. Support custom scoring functions.
- [ ] **Prompt versioning** — Track prompt templates by version, link to spans, support A/B comparison of prompt variants.
- [ ] **Annotation API** — Allow humans to annotate spans/sessions with quality labels for fine-tuning and eval calibration.
- [ ] **Scoring system** — Human, automated (rule-based), and model-based scores on sessions/spans/generations. DuckDB scores table.
- [ ] **Tag system** — Arbitrary key-value tags on sessions/spans for filtering and grouping (project, task_type, prompt_version).
- [ ] **Cost analytics endpoints** — `/api/analytics/cost` with group_by model/agent/user/tag, time windows, daily aggregates.
- [ ] **Latency analytics** — p50/p75/p90/p95/p99 latency per model, TTFT tracking, tokens-per-second output rate.
- [ ] **Trace explorer** — Deep trace tree view with generation detail (input/output/tool_calls), span timeline.
- [ ] **Generation detail view** — Full LLM call inspection: system prompt, user message, tool results, assistant output, metadata.
- [ ] **User/agent analytics** — Per-user dashboards: sessions, cost, pass rate, model usage, daily activity.
- [ ] **Prompt management** — Version tracking, diff view, A/B testing with statistical significance, token budget analysis.
- [ ] **Prompt influence scoring** — Measure which prompt sections correlate with tool call patterns, identify low-influence sections.
- [ ] **Daily aggregates** — Materialized daily_aggregates table for fast charting. Computed on session end.
- [ ] **Live session feed** — SSE endpoint `/api/analytics/live` streaming active session updates.
- [ ] **Alert rules engine** — Configurable alerts: cost breach, error loops, latency spikes. DuckDB alert_rules + alert_events tables.
- [ ] **Anomaly detection** — Automatic detection of pass rate drops, cost spikes, latency regressions.
- [ ] **Auto-scoring** — Automated scoring after session completion: tests_pass, lint_clean, build_success, error_loops, cost_efficiency.
- [ ] **Eval benchmarks** — Run eval datasets across agent+model combinations, produce comparison tables.
- [ ] **Web dashboard** — Local web UI at /dashboard: overview, traces, sessions, analytics charts, prompts, evals, scores.
- [ ] **Dashboard tech decision** — Choose between static SPA (React), HTMX (zero JS build), or Effect Platform UI.

## Phase 4: Sync + Cloud

- [ ] **Parquet export** — DuckDB to Parquet via arrow crate. Partition by workspace/device/date.
- [ ] **R2 sync engine** — S3-compatible upload/download to Cloudflare R2. Manifest-based sync state tracking.
- [ ] **Conflict resolution** — Multi-device sync: last-write-wins for sessions, append-only for spans. Need merge strategy for concurrent edits.
- [ ] **Knowledge store** — Markdown documents in R2 for project context, synced across devices. RAG-friendly chunking.
- [ ] **Encryption at rest** — Optional client-side encryption before R2 upload. Key management TBD.

## Phase 5: Capacity + Project Intelligence

- [ ] **Issue tracker sync** — GitHub Issues, Linear, Notion integration. Pull issue metadata, link to sessions.
- [ ] **Throughput measurement** — Issues resolved per unit time, cost per issue, velocity trends.
- [ ] **Forecasting** — Burndown prediction based on historical throughput. Sprint planning assistance.
- [ ] **Workload modeling** — Estimate agent parallelism, optimal team size, cost projections.
- [ ] **Delegation intelligence** — Recommend which tasks to delegate to agents vs. keep for humans.

## Phase 6: gctl-board (Effect-TS Kanban)

- [ ] **Effect-TS project setup** — Initialize apps/gctl-board/ with Effect, vitest, DuckDB bindings. Decide Bun vs Node.
- [ ] **Core issue CRUD** — Create, read, update, delete issues with Schema validation. Status transitions with WIP limit enforcement.
- [ ] **Dependency resolver** — DAG-based blocking/unblocking with cycle detection. Auto-unblock when dependencies complete.
- [ ] **Event sourcing** — Append-only event log for all issue mutations. Enables audit trail and activity feeds.
- [ ] **Agent coordination protocol** — Task claiming with device-level assignment. Prevent multiple agents claiming same issue. Agent-initiated decomposition.
- [ ] **OTel auto-linkage** — Subscribe to span events, match to issues via branch name, commit message, or explicit link. Accumulate cost/tokens on issues.
- [ ] **CLI bridge** — `gctl board *` commands in Rust that delegate to TS service via HTTP or subprocess spawn.
- [ ] **Board context export** — `gctl board context` generates markdown summary for agent context windows.
- [ ] **Linear sync** — Pull issues from Linear API, map statuses, sync back agent execution data as comments.
- [ ] **GitHub Issues sync** — Pull issues from GitHub, map labels/milestones, push agent summaries.
- [ ] **Kanban web view** — Local web dashboard showing board columns, drag-and-drop (HTMX or React + Effect Platform).
- [ ] **Sub-issue rollup** — Parent issue auto-completes when all sub-issues are done. Cost/token rollup from children.
- [ ] **Agent queue board** — Dedicated board view showing only agent-assignable issues, sorted by priority/unblocked status.
- [ ] **WIP limit policies** — Configurable per-column WIP limits. Effect-based enforcement that returns typed errors.
- [ ] **Acceptance criteria checking** — Machine-verifiable criteria (test pass, lint clean, etc.) that agents can self-evaluate.

## Cross-Cutting Concerns

- [ ] **Config file support** — Load from `~/.config/gctl/config.toml` with proper precedence (env > file > defaults).
- [ ] **Schema migrations** — Version tracking for DuckDB schema changes. Currently tables are CREATE IF NOT EXISTS only.
- [ ] **Daemon mode** — `gctl daemon` that runs OTel receiver + proxy + sync in a single long-lived process.
- [ ] **Structured logging** — JSON logging mode for production, human-readable for dev.
- [ ] **Metrics export** — Expose Prometheus metrics for the daemon itself (spans/sec, storage size, sync status).
- [ ] **Multi-workspace** — Support multiple workspaces in a single DuckDB instance, with workspace-scoped queries.
- [ ] **Agent SDK** — Client library for agents to emit traces directly (bypass OTel if needed).
- [ ] **Web UI** — Local dashboard for browsing sessions, spans, analytics. Consider Leptos or serve static SPA.
- [ ] **Protobuf support** — Full OTLP protobuf decoding (currently JSON only). Needed for compatibility with standard OTel exporters.
- [ ] **Retention policies** — Auto-delete old data based on configurable retention window. Currently config exists but not enforced.
