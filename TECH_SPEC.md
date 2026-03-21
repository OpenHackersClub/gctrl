# GroundCtrl (gctl) — Technical Specification

> Local-first operating system for human+agent teams. Rust daemon with DuckDB storage, OTel ingestion, MITM proxy, and Cloudflare R2 sync.

## 1. Crate Architecture

Cargo workspace with feature-gated crates. Each crate has a clear boundary.

```
gctrl/
├── Cargo.toml              # workspace root
├── crates/
│   ├── gctl-core/          # Domain types, traits, config, errors
│   ├── gctl-cli/           # clap binary, subcommand routing
│   ├── gctl-otel/          # OTLP HTTP receiver (axum), span processing
│   ├── gctl-storage/       # DuckDB embedded storage, schema migrations
│   ├── gctl-proxy/         # MITM proxy (hudsucker), traffic logging
│   ├── gctl-net/           # Web crawl (spider), fetch, readability
│   ├── gctl-sync/          # R2 sync engine (Parquet export, S3 upload)
│   ├── gctl-guardrails/    # Policy engine, cost limits, loop detection
│   ├── gctl-eval/          # Eval suites, scoring, prompt analytics
│   ├── gctl-capacity/      # Throughput, forecasting, workload modeling
│   └── gctl-query/         # Agent data interface, NL→SQL (planned)
├── tests/                  # Integration tests
├── TECH_SPEC.md
├── PRD.md
└── Request.md
```

### Dependency Graph

```
gctl-cli
  ├── gctl-core
  ├── gctl-otel        → gctl-core, gctl-storage
  ├── gctl-storage     → gctl-core
  ├── gctl-proxy       → gctl-core, gctl-storage    [feature: proxy]
  ├── gctl-net         → gctl-core, gctl-storage    [feature: network]
  ├── gctl-sync        → gctl-core, gctl-storage    [feature: r2-sync]
  ├── gctl-guardrails  → gctl-core, gctl-storage
  ├── gctl-eval        → gctl-core, gctl-storage, gctl-otel
  ├── gctl-capacity    → gctl-core, gctl-storage
  └── gctl-query       → gctl-core, gctl-storage
```

## 2. Core Types (`gctl-core`)

### 2.1 Domain Model

```rust
// Identifiers
pub struct WorkspaceId(pub String);
pub struct DeviceId(pub String);
pub struct SessionId(pub String);
pub struct TraceId(pub String);
pub struct SpanId(pub String);

// Execution Layer
pub struct Session {
    pub id: SessionId,
    pub workspace_id: WorkspaceId,
    pub device_id: DeviceId,
    pub agent_name: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub status: SessionStatus,
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
}

pub enum SessionStatus {
    Active,
    Completed,
    Failed,
    Cancelled,
}

pub struct Span {
    pub span_id: SpanId,
    pub trace_id: TraceId,
    pub parent_span_id: Option<SpanId>,
    pub session_id: SessionId,
    pub agent_name: String,
    pub operation_name: String,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub status: SpanStatus,
    pub started_at: DateTime<Utc>,
    pub duration_ms: u64,
    pub attributes: serde_json::Value,
}

pub enum SpanStatus {
    Ok,
    Error(String),
    Unset,
}

pub struct TrafficRecord {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub method: String,
    pub url: String,
    pub host: String,
    pub status_code: u16,
    pub request_size_bytes: u64,
    pub response_size_bytes: u64,
    pub duration_ms: u64,
    pub session_id: Option<SessionId>,
}
```

### 2.2 Key Traits

```rust
/// Storage backend abstraction (DuckDB is the primary impl)
#[async_trait]
pub trait SpanStore: Send + Sync {
    async fn insert_spans(&self, spans: &[Span]) -> Result<()>;
    async fn get_session(&self, id: &SessionId) -> Result<Option<Session>>;
    async fn list_sessions(&self, limit: usize) -> Result<Vec<Session>>;
    async fn query_spans(&self, session_id: &SessionId) -> Result<Vec<Span>>;
    async fn get_analytics(&self, window: Duration) -> Result<Analytics>;
}

#[async_trait]
pub trait TrafficStore: Send + Sync {
    async fn insert_record(&self, record: &TrafficRecord) -> Result<()>;
    async fn query_records(&self, filter: &TrafficFilter) -> Result<Vec<TrafficRecord>>;
    async fn get_stats(&self, window: Option<Duration>) -> Result<TrafficStats>;
}

/// Guardrail policy check
pub trait GuardrailPolicy: Send + Sync {
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}

pub enum PolicyDecision {
    Allow,
    Warn(String),
    Deny(String),
}

/// Sync engine for R2
#[async_trait]
pub trait SyncEngine: Send + Sync {
    async fn push(&self, tables: &[&str]) -> Result<SyncResult>;
    async fn pull(&self, tables: &[&str]) -> Result<SyncResult>;
    async fn status(&self) -> Result<SyncStatus>;
}
```

### 2.3 Configuration

```rust
pub struct GctlConfig {
    pub workspace: WorkspaceConfig,
    pub storage: StorageConfig,
    pub otel: OtelConfig,
    pub proxy: ProxyConfig,
    pub sync: SyncConfig,
    pub guardrails: GuardrailsConfig,
}

pub struct StorageConfig {
    pub db_path: PathBuf,       // default: ~/.local/share/gctl/gctl.duckdb
    pub retention_days: u32,    // default: 30
}

pub struct OtelConfig {
    pub listen_port: u16,       // default: 4318
    pub listen_host: String,    // default: 127.0.0.1
}

pub struct ProxyConfig {
    pub listen_port: u16,       // default: 8080
    pub log_path: PathBuf,
    pub allowed_domains: Vec<String>,
    pub rate_limit_rps: Option<u32>,
}

pub struct SyncConfig {
    pub enabled: bool,
    pub r2_bucket: String,
    pub r2_endpoint: String,
    pub interval_seconds: u64,  // default: 300
    pub device_id: DeviceId,
}

pub struct GuardrailsConfig {
    pub session_budget_usd: Option<f64>,
    pub max_diff_lines: Option<u32>,
    pub loop_detection_threshold: u32,  // default: 5
    pub blocked_commands: Vec<String>,
    pub allow_raw_sql: bool,            // default: false
    pub max_query_rows: u32,            // default: 1000
    pub blocked_columns: Vec<String>,
}
```

## 3. Storage Schema (`gctl-storage`)

DuckDB tables created on first run:

```sql
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR PRIMARY KEY,
    workspace_id    VARCHAR NOT NULL,
    device_id       VARCHAR NOT NULL,
    agent_name      VARCHAR NOT NULL,
    started_at      TIMESTAMP NOT NULL,
    ended_at        TIMESTAMP,
    status          VARCHAR NOT NULL DEFAULT 'active',
    total_cost_usd  DOUBLE DEFAULT 0.0,
    total_input_tokens  BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    synced          BOOLEAN DEFAULT FALSE
);

-- Spans table (Langfuse-inspired hierarchy)
CREATE TABLE IF NOT EXISTS spans (
    span_id         VARCHAR PRIMARY KEY,
    trace_id        VARCHAR NOT NULL,
    parent_span_id  VARCHAR,
    session_id      VARCHAR NOT NULL REFERENCES sessions(id),
    agent_name      VARCHAR NOT NULL,
    operation_name  VARCHAR NOT NULL,
    model           VARCHAR,
    input_tokens    BIGINT DEFAULT 0,
    output_tokens   BIGINT DEFAULT 0,
    cost_usd        DOUBLE DEFAULT 0.0,
    status          VARCHAR NOT NULL DEFAULT 'unset',
    error_message   VARCHAR,
    started_at      TIMESTAMP NOT NULL,
    duration_ms     BIGINT NOT NULL,
    attributes      JSON,
    synced          BOOLEAN DEFAULT FALSE
);

-- Traffic records from MITM proxy
CREATE TABLE IF NOT EXISTS traffic (
    id              VARCHAR PRIMARY KEY,
    timestamp       TIMESTAMP NOT NULL,
    method          VARCHAR NOT NULL,
    url             VARCHAR NOT NULL,
    host            VARCHAR NOT NULL,
    status_code     SMALLINT NOT NULL,
    request_size    BIGINT DEFAULT 0,
    response_size   BIGINT DEFAULT 0,
    duration_ms     BIGINT NOT NULL,
    session_id      VARCHAR,
    synced          BOOLEAN DEFAULT FALSE
);

-- Guardrail events
CREATE TABLE IF NOT EXISTS guardrail_events (
    id              VARCHAR PRIMARY KEY,
    timestamp       TIMESTAMP NOT NULL,
    session_id      VARCHAR,
    policy_name     VARCHAR NOT NULL,
    decision        VARCHAR NOT NULL,  -- 'allow', 'warn', 'deny'
    reason          VARCHAR,
    context         JSON
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic(host);
CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
```

## 3.5. Analytics Schema (DuckDB)

```sql
-- Scores (human annotation + automated)
CREATE TABLE IF NOT EXISTS scores (
    id              VARCHAR PRIMARY KEY,
    target_type     VARCHAR NOT NULL,  -- 'session', 'span', 'generation'
    target_id       VARCHAR NOT NULL,
    name            VARCHAR NOT NULL,  -- 'quality', 'tests_pass', 'cost_efficiency'
    value           DOUBLE NOT NULL,
    comment         VARCHAR,
    source          VARCHAR NOT NULL DEFAULT 'human',  -- 'human', 'auto', 'model'
    scored_by       VARCHAR,
    created_at      VARCHAR NOT NULL
);

-- Tags (arbitrary metadata on sessions/spans)
CREATE TABLE IF NOT EXISTS tags (
    id              VARCHAR PRIMARY KEY,
    target_type     VARCHAR NOT NULL,
    target_id       VARCHAR NOT NULL,
    key             VARCHAR NOT NULL,
    value           VARCHAR NOT NULL
);

-- Prompt versions (snapshot of active prompt at session start)
CREATE TABLE IF NOT EXISTS prompt_versions (
    hash            VARCHAR PRIMARY KEY,
    content         VARCHAR NOT NULL,
    file_path       VARCHAR,
    label           VARCHAR,
    created_at      VARCHAR NOT NULL,
    token_count     INTEGER
);

-- Session-to-prompt linkage
CREATE TABLE IF NOT EXISTS session_prompts (
    session_id      VARCHAR NOT NULL,
    prompt_hash     VARCHAR NOT NULL,
    PRIMARY KEY (session_id, prompt_hash)
);

-- Daily aggregates (materialized for fast charting)
CREATE TABLE IF NOT EXISTS daily_aggregates (
    date            VARCHAR NOT NULL,
    metric          VARCHAR NOT NULL,  -- 'cost', 'sessions', 'tokens', 'pass_rate'
    dimension       VARCHAR NOT NULL DEFAULT 'total',  -- 'total', model name, agent name
    value           DOUBLE NOT NULL,
    PRIMARY KEY (date, metric, dimension)
);

-- Alert rules
CREATE TABLE IF NOT EXISTS alert_rules (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    condition_type  VARCHAR NOT NULL,  -- 'session_cost', 'error_loop', 'latency_spike'
    threshold       DOUBLE NOT NULL,
    action          VARCHAR NOT NULL DEFAULT 'warn',  -- 'warn', 'pause', 'notify'
    enabled         BOOLEAN DEFAULT TRUE
);

-- Alert events (fired alerts)
CREATE TABLE IF NOT EXISTS alert_events (
    id              VARCHAR PRIMARY KEY,
    rule_id         VARCHAR NOT NULL,
    session_id      VARCHAR,
    timestamp       VARCHAR NOT NULL,
    message         VARCHAR NOT NULL,
    acknowledged    BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_scores_target ON scores(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key, value);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_aggregates(date);
CREATE INDEX IF NOT EXISTS idx_session_prompts ON session_prompts(prompt_hash);
```

## 4. OTel Receiver (`gctl-otel`)

### HTTP Endpoint

- `POST /v1/traces` — Accept OTLP/HTTP protobuf or JSON spans
- Parses OpenTelemetry `ExportTraceServiceRequest`
- Extracts semantic conventions: `ai.model.id`, `ai.tokens.input`, `ai.tokens.output`, `ai.tool.name`
- Maps to internal `Span` type
- Writes to DuckDB via `SpanStore`

### Session Management

- Groups spans into sessions by `session.id` resource attribute
- Auto-creates sessions on first span
- Updates session aggregates (cost, tokens) on each span batch

## 5. MITM Proxy (`gctl-proxy`)

- Uses `hudsucker` for transparent HTTP(S) proxy
- Auto-generates CA cert on first run (`~/.local/share/gctl/ca/`)
- Logs every request/response to DuckDB `traffic` table
- Domain allowlist enforcement from config
- Rate limiting per-domain

## 6. Guardrails Engine (`gctl-guardrails`)

Composable policy chain:

```rust
pub struct GuardrailEngine {
    policies: Vec<Box<dyn GuardrailPolicy>>,
}

// Built-in policies:
// - SessionBudgetPolicy: halt if session cost > threshold
// - LoopDetectionPolicy: flag repeated identical tool calls
// - DiffSizePolicy: alert on large diffs
// - CommandAllowlistPolicy: block unauthorized commands
// - BranchProtectionPolicy: prevent direct pushes to main
```

## 7. Query Interface (`gctl-query`)

Three access modes:
1. **Pre-built queries** — Named commands with fixed SQL
2. **Natural language** (planned) — NL→SQL with column allowlist
3. **Raw SQL** (opt-in) — Gated by `allow_raw_sql` config

Output formats: `table`, `json`, `markdown`, `csv`

## 8. Sync Engine (`gctl-sync`)

- Export DuckDB rows to Parquet via `arrow` + `parquet` crates
- Upload to R2 via S3-compatible API
- Partition: `r2://{workspace}/{device}/traces/{timestamp}.parquet`
- Manifest tracking at `r2://_manifests/{device}.json`
- Modes: periodic, on-session-end, manual push/pull

## 9. Phased Implementation Plan

### Phase 1: Foundation (MVP)
- [x] Core types and traits
- [x] DuckDB storage with schema migrations
- [x] CLI skeleton with clap
- [x] OTel HTTP receiver (axum)
- [x] Basic session/span queries

### Phase 2: Guardrails + Proxy
- [ ] Guardrail policy engine
- [ ] MITM proxy with traffic logging
- [ ] Command gateway enforcement
- [ ] Cost limits and loop detection

### Phase 3: Query + Eval
- [ ] `gctl query` agent data interface
- [ ] Eval suite definition and scoring
- [ ] Prompt versioning and A/B comparison

### Phase 4: Sync + Cloud
- [ ] Parquet export from DuckDB
- [ ] R2 upload/download
- [ ] Manifest-based sync state
- [ ] Knowledge store (markdown in R2)

### Phase 5: Capacity + Project Intelligence
- [ ] Issue tracker sync (GitHub, Linear, Notion)
- [ ] Throughput measurement
- [ ] Forecasting and burndown
- [ ] Sprint planning assistance

### Phase 6: gctl-board (Effect-TS)
- [ ] Effect-TS project setup (packages/gctl-board/)
- [ ] Core schemas: Issue, IssueEvent, Comment, Board, Project
- [ ] BoardService with CRUD, status transitions, WIP limits
- [ ] DependencyResolver with cycle detection
- [ ] DuckDB storage for board tables (issues, events, comments)
- [ ] HTTP API (Effect Platform HttpApi)
- [ ] CLI bridge: `gctl board *` commands delegate to TS service
- [ ] OTel integration: auto-link sessions to issues
- [ ] Agent coordination: claim, decompose, block/unblock, handoff
- [ ] External sync: Linear pull, GitHub Issues pull

## 10. gctl-board Architecture (Effect-TS)

### 10.1. Package Structure

```
packages/gctl-board/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Entry point
│   ├── schema/
│   │   ├── Issue.ts             # Issue, IssueStatus, Priority schemas
│   │   ├── IssueEvent.ts        # Event log schema
│   │   ├── Comment.ts           # Comment schema
│   │   ├── Board.ts             # Board, KanbanView schemas
│   │   ├── Project.ts           # Project schema
│   │   └── Assignee.ts          # Assignee (human | agent) schema
│   ├── services/
│   │   ├── BoardService.ts      # Core CRUD + status transitions
│   │   ├── DependencyResolver.ts # DAG-based blocking/unblocking
│   │   ├── EventLog.ts          # Append-only event log
│   │   └── OtelBridge.ts        # Session-issue auto-linkage
│   ├── storage/
│   │   ├── BoardStore.ts        # DuckDB storage layer
│   │   └── schema.sql           # Board-specific DuckDB tables
│   ├── api/
│   │   ├── routes.ts            # Effect HttpApi route definitions
│   │   └── server.ts            # HTTP server setup
│   └── cli/
│       └── bridge.ts            # CLI argument handler (called from Rust)
├── test/
│   ├── BoardService.test.ts
│   ├── DependencyResolver.test.ts
│   └── api.test.ts
└── vitest.config.ts
```

### 10.2. DuckDB Tables (Board)

```sql
CREATE TABLE IF NOT EXISTS board_projects (
    id          VARCHAR PRIMARY KEY,
    name        VARCHAR NOT NULL,
    key         VARCHAR NOT NULL UNIQUE,
    counter     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS board_issues (
    id              VARCHAR PRIMARY KEY,
    project_id      VARCHAR NOT NULL,
    title           VARCHAR NOT NULL,
    description     VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'backlog',
    priority        VARCHAR NOT NULL DEFAULT 'none',
    assignee_id     VARCHAR,
    assignee_name   VARCHAR,
    assignee_type   VARCHAR,  -- 'human' | 'agent'
    labels          JSON DEFAULT '[]',
    parent_id       VARCHAR,
    estimate        DOUBLE,
    due_date        VARCHAR,
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
    created_by_id   VARCHAR NOT NULL,
    created_by_name VARCHAR NOT NULL,
    created_by_type VARCHAR NOT NULL,
    blocked_by      JSON DEFAULT '[]',
    blocking        JSON DEFAULT '[]',
    agent_notes     VARCHAR,
    acceptance_criteria JSON DEFAULT '[]',
    session_ids     JSON DEFAULT '[]',
    total_cost_usd  DOUBLE DEFAULT 0.0,
    total_tokens    BIGINT DEFAULT 0,
    pr_numbers      JSON DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS board_events (
    id          VARCHAR PRIMARY KEY,
    issue_id    VARCHAR NOT NULL,
    type        VARCHAR NOT NULL,
    actor_id    VARCHAR NOT NULL,
    actor_name  VARCHAR NOT NULL,
    actor_type  VARCHAR NOT NULL,
    timestamp   VARCHAR NOT NULL,
    data        JSON
);

CREATE TABLE IF NOT EXISTS board_comments (
    id          VARCHAR PRIMARY KEY,
    issue_id    VARCHAR NOT NULL,
    author_id   VARCHAR NOT NULL,
    author_name VARCHAR NOT NULL,
    author_type VARCHAR NOT NULL,
    body        VARCHAR NOT NULL,
    created_at  VARCHAR NOT NULL,
    session_id  VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON board_issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON board_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON board_issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON board_issues(parent_id);
CREATE INDEX IF NOT EXISTS idx_events_issue ON board_events(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON board_comments(issue_id);
```

### 10.3. Integration with Rust Daemon

The Rust CLI delegates board commands to the TS service:

```
gctl board issue list --status todo
  → Rust CLI parses args
  → HTTP GET http://localhost:4318/api/board/issues?status=todo
  → TS service queries DuckDB, returns JSON
  → Rust CLI formats output (table/json)
```

Or for offline/no-server mode, Rust can spawn a short-lived TS process:

```
gctl board issue list --status todo
  → Rust CLI detects server not running
  → Spawns: bun run packages/gctl-board/src/cli/bridge.ts issue list --status todo
  → TS process opens DuckDB, runs query, outputs JSON
  → Rust CLI formats output
```

## 11. Testing Strategy

- **Unit tests**: Per-crate, covering type conversions, policy logic, config parsing
- **Integration tests**: DuckDB round-trip (insert → query), OTel endpoint acceptance, proxy traffic logging
- **Test fixtures**: Sample OTLP payloads, mock traffic logs
- **Property tests**: Span hierarchy invariants, cost aggregation accuracy
- **No external deps in tests**: In-memory DuckDB, mock HTTP servers via `axum::test`
