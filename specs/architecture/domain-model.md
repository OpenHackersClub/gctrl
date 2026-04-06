# Domain Model Reference

> Canonical domain model for GroundCtrl (gctl).

---

## 1. Domain Identifiers

```rust
pub struct WorkspaceId(pub String);
pub struct DeviceId(pub String);
pub struct SessionId(pub String);
pub struct TraceId(pub String);
pub struct SpanId(pub String);
pub struct TaskId(pub String);
pub struct ScheduleId(pub String);
```

---

## 2. Core Domain Types

### Session

```rust
pub struct Session {
    pub id: SessionId,
    pub workspace_id: WorkspaceId,
    pub device_id: DeviceId,
    pub user_id: Option<UserId>,   // persona identity (FK → users)
    pub agent_kind: AgentKind,     // agent system: claude-code, codex, aider, etc.
    pub agent_name: String,        // display name of the agent program instance
    pub task_id: Option<TaskId>,   // the Scheduler Task this session is executing (if any)
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub status: SessionStatus,
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
}
```

**Terminology disambiguation:**
- `user_id` — the persona identity (who is running this session, e.g. `reviewer-bot`)
- `agent_kind` — the agent system/program (what is running, e.g. `ClaudeCode`, `Codex`)
- `agent_name` — display label (e.g. `"Claude Code"`, `"Codex CLI"`)
- `task_id` — the Scheduler Task this session is working on (nullable for ad-hoc sessions)

### SessionStatus

> States: `Active` (initial) → `Completed` | `Failed` | `Cancelled` (terminal).

### Span

```rust
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
```

### SpanStatus

> States: `Ok` (success) | `Error` | `Unset` (pending).

### Task

Owned by the **Scheduler** kernel primitive. Represents a unit of agent work, normalized across all agent systems. See `specs/architecture/kernel/scheduler.md` for the full type definition and port interface.

```rust
pub struct Task {
    pub id: TaskId,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub agent_kind: AgentKind,
    pub session_id: Option<SessionId>,
    pub prompt_hash: Option<String>,    // FK → prompt_versions
    pub parent_task_id: Option<TaskId>,
    pub blocked_by: Vec<TaskId>,
    pub blocking: Vec<TaskId>,
    pub workspace: Option<String>,
    pub created_by_id: String,
    pub created_by_kind: ActorKind,
    pub context: serde_json::Value,     // agent-system-specific metadata
    pub result: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// TaskStatus — see domain-model.md § Task
// AgentKind  — see domain-model.md § Domain Types
// ActorKind  — see domain-model.md § Domain Types
```

### User

See `specs/architecture/os.md` § 6 for the full execution model (users, personas, capabilities).

```rust
pub struct UserId(pub String);

pub struct User {
    pub id: UserId,
    pub name: String,
    pub kind: UserKind,
    pub model: Option<String>,       // LLM model for agent personas
    pub capabilities: Vec<String>,   // tool/command allowlist
    pub cost_limit_usd: Option<f64>, // per-session cost cap
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// UserKind — see domain-model.md § Domain Types
// States: Human | Agent | System (kernel-internal only)
// Verified: ActorKind ↪ UserKind injective embedding, System not an actor
```

### TrafficRecord

```rust
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

### PolicyDecision

> States: `Allow` (severity 0) | `Warn` (severity 1) | `Deny` (severity 2).

### BrowserRef

```rust
/// Element reference from accessibility tree snapshot
pub struct BrowserRef {
    pub id: String,              // "@e1", "@e2", "@c1", etc.
    pub role: String,            // ARIA role: "button", "textbox", "link"
    pub name: String,            // Accessible name
    pub namespace: RefNamespace, // Element vs Cursor-interactive
}

pub enum RefNamespace {
    Element,          // @e1, @e2 -- from ARIA tree
    CursorInteractive, // @c1, @c2 -- cursor:pointer / onclick not in ARIA
}
```

### BrowserDaemonState

```rust
pub struct BrowserDaemonState {
    pub pid: u32,
    pub port: u16,
    pub token: String,          // UUID v4, bearer auth
    pub started_at: DateTime<Utc>,
    pub version: String,        // gctl binary version
}
```

---

## 3. Key Traits

### SpanStore

```rust
#[async_trait]
pub trait SpanStore: Send + Sync {
    async fn insert_spans(&self, spans: &[Span]) -> Result<()>;
    async fn get_session(&self, id: &SessionId) -> Result<Option<Session>>;
    async fn list_sessions(&self, limit: usize) -> Result<Vec<Session>>;
    async fn query_spans(&self, session_id: &SessionId) -> Result<Vec<Span>>;
    async fn get_analytics(&self, window: Duration) -> Result<Analytics>;
}
```

### TrafficStore

```rust
#[async_trait]
pub trait TrafficStore: Send + Sync {
    async fn insert_record(&self, record: &TrafficRecord) -> Result<()>;
    async fn query_records(&self, filter: &TrafficFilter) -> Result<Vec<TrafficRecord>>;
    async fn get_stats(&self, window: Option<Duration>) -> Result<TrafficStats>;
}
```

### GuardrailPolicy

```rust
pub trait GuardrailPolicy: Send + Sync {
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}
```

Built-in policies:
- `SessionBudgetPolicy` -- halt if session cost exceeds threshold
- `LoopDetectionPolicy` -- flag repeated identical tool calls
- `DiffSizePolicy` -- alert on large diffs
- `CommandAllowlistPolicy` -- block unauthorized commands
- `BranchProtectionPolicy` -- prevent direct pushes to main

### SyncEngine

> Full design: [kernel/sync.md](kernel/sync.md) — manifest format, R2 paths, conflict resolution, context sync.

```rust
#[async_trait]
pub trait SyncEngine: Send + Sync {
    async fn push(&self, tables: &[&str]) -> Result<SyncResult>;
    async fn pull(&self, tables: &[&str]) -> Result<SyncResult>;
    async fn status(&self) -> Result<SyncStatus>;
}
```

---

### BrowserPort

```rust
#[async_trait]
pub trait BrowserPort: Send + Sync {
    async fn start(&self) -> Result<BrowserDaemonState>;
    async fn stop(&self) -> Result<()>;
    async fn status(&self) -> Result<Option<BrowserDaemonState>>;
    async fn execute(&self, command: BrowserCommand) -> Result<String>;
    async fn snapshot(&self, interactive: bool) -> Result<Vec<BrowserRef>>;
    async fn screenshot(&self) -> Result<Vec<u8>>;
}
```

---

## 4. Configuration Types

```rust
pub struct GctlConfig {
    pub workspace: WorkspaceConfig,
    pub storage: StorageConfig,
    pub otel: OtelConfig,
    pub proxy: ProxyConfig,
    pub browser: BrowserConfig,
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

pub struct BrowserConfig {
    pub headless: bool,              // default: true
    pub idle_timeout_seconds: u64,   // default: 1800
    pub viewport_width: u32,         // default: 1280
    pub viewport_height: u32,        // default: 720
    pub chromium_path: Option<PathBuf>,
    pub user_data_dir: Option<PathBuf>,
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

---

## 5. Storage Schema (DuckDB)

### 5.1 Core Tables

```sql
-- Users table (humans and agent personas — see os.md § 6)
CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    kind            VARCHAR NOT NULL,       -- 'human', 'agent', 'system'
    model           VARCHAR,                -- LLM model for agent personas (e.g. 'claude-sonnet-4-6')
    capabilities    JSON DEFAULT '[]',      -- tool/command allowlist
    cost_limit_usd  DOUBLE,                 -- per-session cost cap (guardrails binding)
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR PRIMARY KEY,
    workspace_id    VARCHAR NOT NULL,
    device_id       VARCHAR NOT NULL,
    user_id         VARCHAR REFERENCES users(id),  -- persona identity (who is running)
    agent_kind      VARCHAR NOT NULL,               -- agent system: 'claude-code', 'codex', 'aider', 'openai', 'custom:<name>'
    agent_name      VARCHAR NOT NULL,               -- display label (e.g. 'Claude Code')
    task_id         VARCHAR,                        -- FK → tasks (Scheduler Task being executed, nullable for ad-hoc)
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

-- Tasks table (Scheduler kernel primitive)
-- Normalized record of all agent work across all agent systems (Claude Code, Codex, Aider, OpenAI, custom).
-- Every agent MUST create tasks here via SchedulerPort — never write directly.
CREATE TABLE IF NOT EXISTS tasks (
    id              VARCHAR PRIMARY KEY,
    title           VARCHAR NOT NULL,
    description     VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'pending',  -- pending, running, paused, done, failed, cancelled
    agent_kind      VARCHAR NOT NULL,                    -- 'claude-code', 'codex', 'aider', 'openai', 'custom:<name>'
    session_id      VARCHAR REFERENCES sessions(id),     -- active or last session executing this task
    prompt_hash     VARCHAR,                             -- FK → prompt_versions (the rendered prompt)
    parent_task_id  VARCHAR,                             -- sub-task relationship (nullable)
    blocked_by      JSON DEFAULT '[]',                   -- dependency DAG: list of task IDs this is blocked by
    blocking        JSON DEFAULT '[]',                   -- reverse edges for fast lookup
    workspace       VARCHAR,                             -- isolated workspace directory path
    created_by_id   VARCHAR NOT NULL,
    created_by_kind VARCHAR NOT NULL,                    -- 'human' | 'agent'
    context         JSON,                               -- agent-system-specific metadata (model, persona, flags, etc.)
    result          JSON,                               -- artifacts produced (commits, PRs, file paths)
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
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
```

### 5.2 Core Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic(host);
CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_users_kind ON users(kind);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_kind ON tasks(agent_kind);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_prompt ON tasks(prompt_hash);
```

### 5.3 Core Tables (continued) — Prompts, Alerts, Metadata

These are **kernel-owned** tables, not application tables. They support kernel primitives (Scheduler, Guardrails, Telemetry) and do not carry application namespace prefixes.

```sql
-- Prompt versions — kernel-owned snapshot of rendered prompts.
-- Referenced by tasks.prompt_hash (Scheduler) and session_prompts (Telemetry).
CREATE TABLE IF NOT EXISTS prompt_versions (
    hash            VARCHAR PRIMARY KEY,
    content         VARCHAR NOT NULL,
    file_path       VARCHAR,
    label           VARCHAR,
    created_at      VARCHAR NOT NULL,
    token_count     INTEGER
);

-- Session-to-prompt linkage (kernel: Telemetry)
CREATE TABLE IF NOT EXISTS session_prompts (
    session_id      VARCHAR NOT NULL,
    prompt_hash     VARCHAR NOT NULL,
    PRIMARY KEY (session_id, prompt_hash)
);

-- Tags (kernel: general-purpose metadata on sessions/spans/tasks)
CREATE TABLE IF NOT EXISTS tags (
    id              VARCHAR PRIMARY KEY,
    target_type     VARCHAR NOT NULL,  -- 'session', 'span', 'task'
    target_id       VARCHAR NOT NULL,
    key             VARCHAR NOT NULL,
    value           VARCHAR NOT NULL
);

-- Daily aggregates (kernel: materialized for fast charting)
CREATE TABLE IF NOT EXISTS daily_aggregates (
    date            VARCHAR NOT NULL,
    metric          VARCHAR NOT NULL,  -- 'cost', 'sessions', 'tokens', 'pass_rate'
    dimension       VARCHAR NOT NULL DEFAULT 'total',  -- 'total', model name, agent name
    value           DOUBLE NOT NULL,
    PRIMARY KEY (date, metric, dimension)
);

-- Alert rules (kernel: Guardrails primitive)
CREATE TABLE IF NOT EXISTS alert_rules (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    condition_type  VARCHAR NOT NULL,  -- 'session_cost', 'error_loop', 'latency_spike'
    threshold       DOUBLE NOT NULL,
    action          VARCHAR NOT NULL DEFAULT 'warn',  -- 'warn', 'pause', 'notify'
    enabled         BOOLEAN DEFAULT TRUE
);

-- Alert events (kernel: Guardrails primitive)
CREATE TABLE IF NOT EXISTS alert_events (
    id              VARCHAR PRIMARY KEY,
    rule_id         VARCHAR NOT NULL,
    session_id      VARCHAR,
    timestamp       VARCHAR NOT NULL,
    message         VARCHAR NOT NULL,
    acknowledged    BOOLEAN DEFAULT FALSE
);
```

### 5.4 Eval Application Tables

These are owned by the **Observe & Eval** application and MUST carry the `eval_` namespace prefix per Invariant #3.

```sql
-- Eval scores (human annotation + automated evaluation)
CREATE TABLE IF NOT EXISTS eval_scores (
    id              VARCHAR PRIMARY KEY,
    target_type     VARCHAR NOT NULL,  -- 'session', 'span', 'task'
    target_id       VARCHAR NOT NULL,
    name            VARCHAR NOT NULL,  -- 'quality', 'tests_pass', 'cost_efficiency'
    value           DOUBLE NOT NULL,
    comment         VARCHAR,
    source          VARCHAR NOT NULL DEFAULT 'human',  -- 'human', 'auto', 'model'
    scored_by       VARCHAR,
    created_at      VARCHAR NOT NULL
);
```

### 5.5 Core + Eval Indexes

```sql
-- Core (kernel-owned)
CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key, value);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_aggregates(date);
CREATE INDEX IF NOT EXISTS idx_session_prompts ON session_prompts(prompt_hash);

-- Eval application
CREATE INDEX IF NOT EXISTS idx_eval_scores_target ON eval_scores(target_type, target_id);
```

### 5.6 Board Tables

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
```

### 5.7 Board Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_issues_project ON board_issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON board_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON board_issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON board_issues(parent_id);
CREATE INDEX IF NOT EXISTS idx_events_issue ON board_events(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON board_comments(issue_id);
```

---

## 6. gctl-board Effect-TS Schemas

Source: `apps/gctl-board/src/schema/`

### Branded Identifiers (Value Objects)

```typescript
const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
const BoardId = Schema.String.pipe(Schema.brand("BoardId"))
```

### Enumerations

```typescript
const IssueStatus = Schema.Literal(
  "backlog", "todo", "in_progress", "in_review", "done", "cancelled"
)

const Priority = Schema.Literal("urgent", "high", "medium", "low", "none")

const AssigneeType = Schema.Literal("human", "agent")
```

### Assignee

```typescript
const Assignee = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: AssigneeType,
  deviceId: Schema.optional(Schema.String),
})
```

### Issue

```typescript
const Issue = Schema.Struct({
  id: IssueId,
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: IssueStatus,
  priority: Priority,
  assignee: Schema.optional(Assignee),
  labels: Schema.Array(Schema.String),
  parentId: Schema.optional(IssueId),
  estimate: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Assignee,
  // Execution linkage
  sessionIds: Schema.Array(Schema.String),
  totalCostUsd: Schema.Number,
  totalTokens: Schema.Number,
  prNumbers: Schema.Array(Schema.Number),
  // Agent coordination
  blockedBy: Schema.Array(IssueId),
  blocking: Schema.Array(IssueId),
  agentNotes: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
})
```

### CreateIssueInput

```typescript
const CreateIssueInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  priority: Schema.optional(Priority),
  labels: Schema.optional(Schema.Array(Schema.String)),
  parentId: Schema.optional(IssueId),
  estimate: Schema.optional(Schema.Number),
  createdBy: Assignee,
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
})
```

### IssueFilter

```typescript
const IssueFilter = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  status: Schema.optional(IssueStatus),
  priority: Schema.optional(Priority),
  assigneeId: Schema.optional(Schema.String),
  assigneeType: Schema.optional(AssigneeType),
  label: Schema.optional(Schema.String),
  parentId: Schema.optional(IssueId),
  unassigned: Schema.optional(Schema.Boolean),
})
```

### IssueEvent

```typescript
const IssueEventType = Schema.Literal(
  "created", "status_changed", "assigned", "unassigned",
  "comment_added", "label_added", "label_removed",
  "linked_session", "linked_pr", "estimate_changed",
  "priority_changed", "decomposed", "blocked", "unblocked"
)

const IssueEvent = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  type: IssueEventType,
  actor: Assignee,
  timestamp: Schema.String,
  data: Schema.Unknown,
})
```

### Comment

```typescript
const Comment = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  author: Assignee,
  body: Schema.String,
  createdAt: Schema.String,
  sessionId: Schema.optional(Schema.String),
})
```

### Board

```typescript
const Board = Schema.Struct({
  id: BoardId,
  projectId: Schema.String,
  name: Schema.String,
  columns: Schema.Array(IssueStatus),
  wipLimits: Schema.Record({ key: Schema.String, value: Schema.Number }),
})
```

### Project

```typescript
const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  defaultBoard: Schema.optional(BoardId),
  autoIncrementCounter: Schema.Number,
})
```
