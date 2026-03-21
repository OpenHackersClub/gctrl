# Request.md — Deferred Items & Open Questions

Gaps and product requirements to address in future phases.

## Phase 2: Guardrails + Proxy

- [ ] **MITM proxy integration** — Implement hudsucker-based proxy with auto-CA generation, domain allowlist, rate limiting. Requires TLS cert trust setup (macOS Keychain, Linux ca-certificates).
- [ ] **Command gateway** — Intercept shell commands before execution, enforce blocklist, require approval for destructive ops (rm -rf, git push --force).
- [ ] **Real-time guardrail hooks** — MCP-compatible hook protocol so agents can check policies before tool execution, not just after-the-fact.
- [ ] **Guardrail event persistence** — Store all policy decisions (allow/warn/deny) in guardrail_events table for audit trail.

## Phase 3: Query + Eval

- [ ] **Natural language to SQL** — NL query interface with column allowlist, query rewriting, and safety guards. Requires LLM integration for SQL generation.
- [ ] **Raw SQL execution** — Gated by config flag. Needs sandboxing (read-only mode, row limits, blocked columns).
- [ ] **Eval suite engine** — Define eval suites (YAML/JSON), run against stored traces, compute pass/fail scores. Support custom scoring functions.
- [ ] **Prompt versioning** — Track prompt templates by version, link to spans, support A/B comparison of prompt variants.
- [ ] **Annotation API** — Allow humans to annotate spans/sessions with quality labels for fine-tuning and eval calibration.

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
