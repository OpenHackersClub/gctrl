# Domain Model Reference

> Canonical domain model for GroundCtrl (gctl).
>
> **Policy:** Types that exist in the codebase link to source (single source of truth, zero drift). Types that are specs-only — not yet implemented — remain inline here, and the spec is authoritative until the code catches up.

---

## 1. Domain Identifiers

Newtype wrappers over `String` with `Serialize`/`Deserialize`.

| Type | Source |
|------|--------|
| `WorkspaceId`, `DeviceId`, `SessionId`, `TraceId`, `SpanId` | [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) § Identifiers |
| `TaskId` *(specs-only)* | see § 2 Task below |
| `UserId` *(specs-only)* | see § 2 User below |
| `ScheduleId` *(specs-only)* | [`kernel/scheduler.md`](kernel/scheduler.md) |

---

## 2. Core Domain Types

### Session

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `Session` struct.

Current shape: `id`, `workspace_id`, `device_id`, `agent_name`, `started_at`, `ended_at`, `status`, `total_cost_usd`, `total_input_tokens`, `total_output_tokens`.

**Spec-only additions** (planned; not yet in code):

```rust
user_id: Option<UserId>   // persona identity (FK → users)
agent_kind: AgentKind     // agent system: claude-code, codex, aider, etc.
task_id: Option<TaskId>   // Scheduler Task this session is executing
```

**Terminology disambiguation:**
- `user_id` — persona identity (who is running this session, e.g. `reviewer-bot`)
- `agent_kind` — agent system/program (what is running, e.g. `ClaudeCode`, `Codex`)
- `agent_name` — display label (e.g. `"Claude Code"`, `"Codex CLI"`)
- `task_id` — the Scheduler Task this session is working on (nullable for ad-hoc sessions)

### SessionStatus

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `SessionStatus` enum.

States: `Active` (initial) → `Completed` | `Failed` | `Cancelled` (terminal).

### Span

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `Span` struct (includes `span_type`: `Generation` | `Span` | `Event`).

### SpanStatus

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `SpanStatus` enum.

States: `Ok` | `Error(String)` | `Unset` (pending).

### Task *(specs-only)*

Owned by the **Scheduler** kernel primitive. Normalized representation of agent work across all agent systems. See [`kernel/scheduler.md`](kernel/scheduler.md) for the full port interface.

```rust
pub struct TaskId(pub String);

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
```

`TaskStatus`: `Pending` | `Running` | `Paused` | `Done` | `Failed` | `Cancelled`.

### User *(specs-only)*

See [`os.md`](os.md) § 6 for the full execution model (users, personas, capabilities).

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
```

`UserKind`: `Human` | `Agent` | `System` (kernel-internal only). `ActorKind ↪ UserKind` is an injective embedding; `System` is not an actor.

### TrafficRecord

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `TrafficRecord` struct.

### PolicyDecision

**Source:** [`kernel/crates/gctl-core/src/types.rs`](../../kernel/crates/gctl-core/src/types.rs) — `PolicyDecision` enum.

Variants: `Allow` | `Warn(String)` | `Deny(String)`.

### BrowserRef *(specs-only)*

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

### BrowserDaemonState *(specs-only)*

```rust
pub struct BrowserDaemonState {
    pub pid: u32,
    pub port: u16,
    pub token: String,          // UUID v4, bearer auth
    pub started_at: DateTime<Utc>,
    pub version: String,        // gctl binary version
}
```

### WikiMeta / WikiPageType *(specs-only)*

Knowledge-base fields layered onto `ContextEntry`. See [`kernel/knowledgebase.md`](kernel/knowledgebase.md) for the full wiki design.

```rust
pub struct WikiMeta {
    pub parent_id: Option<String>,       // hierarchical parent page
    pub links_to: Vec<String>,           // forward links (extracted from [[wikilinks]])
    pub linked_from: Vec<String>,        // backlinks (computed from kb_links)
    pub page_type: WikiPageType,
    pub source_ids: Vec<String>,         // raw sources this page synthesizes
    pub last_lint: Option<DateTime<Utc>>,
}

pub enum WikiPageType {
    Index,          // catalog page (index.md)
    Log,            // chronological log (log.md)
    Entity,         // person, org, tool, project
    Topic,          // concept, domain area
    Source,         // summary of a raw source document
    Synthesis,      // cross-cutting analysis, comparison, thesis
    Question,       // filed query result worth keeping
}
```

---

## 3. Key Traits

### SpanStore *(specs-only)*

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

### TrafficStore *(specs-only)*

```rust
#[async_trait]
pub trait TrafficStore: Send + Sync {
    async fn insert_record(&self, record: &TrafficRecord) -> Result<()>;
    async fn query_records(&self, filter: &TrafficFilter) -> Result<Vec<TrafficRecord>>;
    async fn get_stats(&self, window: Option<Duration>) -> Result<TrafficStats>;
}
```

### GuardrailPolicy

**Source:** [`kernel/crates/gctl-guardrails/src/engine.rs`](../../kernel/crates/gctl-guardrails/src/engine.rs) — `GuardrailPolicy` trait.

Built-in policies *(partially implemented; see `gctl-guardrails/src/policies.rs`)*:
- `SessionBudgetPolicy` — halt if session cost exceeds threshold
- `LoopDetectionPolicy` — flag repeated identical tool calls
- `DiffSizePolicy` — alert on large diffs
- `CommandAllowlistPolicy` — block unauthorized commands
- `BranchProtectionPolicy` — prevent direct pushes to main

### SyncEngine

**Source:** [`kernel/crates/gctl-sync/src/engine.rs`](../../kernel/crates/gctl-sync/src/engine.rs) — `SyncEngine` trait. Full design in [`kernel/sync.md`](kernel/sync.md).

### SchedulerPort *(specs-only)*

Kernel primitive for Task management and deferred/recurring execution. Every agent system MUST create Tasks through this interface — never write to the `tasks` table directly. Full design in [`kernel/scheduler.md`](kernel/scheduler.md).

```rust
#[async_trait]
pub trait SchedulerPort: Send + Sync {
    // --- Task management ---
    async fn create_task(&self, input: CreateTaskInput) -> Result<Task, SchedulerError>;
    async fn update_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<Task, SchedulerError>;
    async fn complete_task(&self, id: &TaskId, result: serde_json::Value) -> Result<Task, SchedulerError>;
    async fn fail_task(&self, id: &TaskId, reason: &str) -> Result<Task, SchedulerError>;
    async fn cancel_task(&self, id: &TaskId, reason: &str) -> Result<Task, SchedulerError>;
    async fn get_task(&self, id: &TaskId) -> Result<Task, SchedulerError>;
    async fn list_tasks(&self, filter: TaskFilter) -> Result<Vec<Task>, SchedulerError>;
    async fn link_session(&self, task_id: &TaskId, session_id: &SessionId) -> Result<(), SchedulerError>;

    // --- Dependency graph (acyclicity MUST be enforced) ---
    async fn add_dependency(&self, blocker: TaskId, blocked: TaskId) -> Result<(), CyclicDependencyError>;
    async fn remove_dependency(&self, blocker: TaskId, blocked: TaskId) -> Result<(), SchedulerError>;
    async fn list_ready(&self) -> Result<Vec<Task>, SchedulerError>;

    // --- Deferred / recurring scheduling ---
    async fn schedule_once(&self, task: TaskId, at: DateTime<Utc>) -> Result<ScheduleId, SchedulerError>;
    async fn schedule_recurring(&self, task: TaskId, cron: &str) -> Result<ScheduleId, SchedulerError>;
    async fn cancel_schedule(&self, id: &ScheduleId) -> Result<(), SchedulerError>;
}

pub struct CreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub agent_kind: AgentKind,
    pub prompt_hash: Option<String>,   // pre-register prompt via prompt_versions
    pub parent_task_id: Option<TaskId>,
    pub created_by_id: String,
    pub created_by_kind: ActorKind,
    pub context: serde_json::Value,    // agent-system-specific metadata
}
```

### BrowserPort *(specs-only)*

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

**Source:** [`kernel/crates/gctl-core/src/config.rs`](../../kernel/crates/gctl-core/src/config.rs).

`GctlConfig` composes: `StorageConfig`, `OtelConfig`, `ProxyConfig`, `SyncConfig`, `GuardrailsConfig`. See source for field-level defaults.

**Spec-only sub-configs** (planned; not yet in code):
- `WorkspaceConfig` — workspace identity + path
- `BrowserConfig` — headless, viewport, chromium_path, user_data_dir, idle_timeout
- `SyncConfig.r2_bucket` additional fields for R2 path conventions (see [`kernel/sync.md`](kernel/sync.md))

---

## 5. Storage Schema (DuckDB)

**Source:** [`kernel/crates/gctl-storage/src/schema.rs`](../../kernel/crates/gctl-storage/src/schema.rs) — all `CREATE_*_TABLE` constants and `CREATE_INDEXES`.

### 5.1 Kernel-owned tables (implemented)

From `schema.rs`: `sessions`, `spans`, `traffic`, `guardrail_events`, `scores`, `tags`, `prompt_versions`, `session_prompts`, `daily_aggregates`, `alert_rules`, `alert_events`, `context_entries`, `persona_definitions`, `persona_review_rules`, `inbox_messages`, `inbox_threads`, `inbox_actions`, `inbox_subscriptions`.

**Spec-only extensions** (not yet in schema.rs):

```sql
-- users table (see os.md § 6 — persona identity model)
CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    kind            VARCHAR NOT NULL,       -- 'human', 'agent', 'system'
    model           VARCHAR,
    capabilities    JSON DEFAULT '[]',
    cost_limit_usd  DOUBLE,
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL
);

-- tasks table (Scheduler kernel primitive — see kernel/scheduler.md)
CREATE TABLE IF NOT EXISTS tasks (
    id              VARCHAR PRIMARY KEY,
    title           VARCHAR NOT NULL,
    description     VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'pending',
    agent_kind      VARCHAR NOT NULL,
    session_id      VARCHAR REFERENCES sessions(id),
    prompt_hash     VARCHAR,
    parent_task_id  VARCHAR,
    blocked_by      JSON DEFAULT '[]',
    blocking        JSON DEFAULT '[]',
    workspace       VARCHAR,
    created_by_id   VARCHAR NOT NULL,
    created_by_kind VARCHAR NOT NULL,
    context         JSON,
    result          JSON,
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
    synced          BOOLEAN DEFAULT FALSE
);

-- sessions table additions:
--   user_id         VARCHAR REFERENCES users(id)
--   agent_kind      VARCHAR NOT NULL
--   task_id         VARCHAR REFERENCES tasks(id)

-- kb_links table (knowledgebase wiki link graph — see kernel/knowledgebase.md)
CREATE TABLE IF NOT EXISTS kb_links (
    source_id   VARCHAR NOT NULL,    -- entry containing the link
    target_id   VARCHAR NOT NULL,    -- entry being linked to
    link_type   VARCHAR NOT NULL DEFAULT 'reference',  -- reference, parent, prerequisite, refines, contradicts
    created_at  VARCHAR NOT NULL,
    PRIMARY KEY (source_id, target_id, link_type)
);

-- kb_pages table (wiki-specific metadata, FK → context_entries)
CREATE TABLE IF NOT EXISTS kb_pages (
    entry_id    VARCHAR PRIMARY KEY,
    page_type   VARCHAR NOT NULL DEFAULT 'topic',
    parent_id   VARCHAR,
    source_ids  JSON DEFAULT '[]',
    last_lint   VARCHAR
);
```

Every agent MUST create tasks via `SchedulerPort` — never write directly.

### 5.2 Board application tables

**Source:** [`kernel/crates/gctl-storage/src/schema.rs`](../../kernel/crates/gctl-storage/src/schema.rs) — `CREATE_BOARD_*_TABLE` constants: `board_projects`, `board_issues`, `board_events`, `board_comments`.

Per Invariant #3, application tables carry the `board_` namespace prefix.

### 5.3 Eval application tables

From `schema.rs`: `scores` (kernel-owned, general target_type/target_id). The `eval_scores` prefix in earlier spec revisions was folded into the kernel-owned `scores` table; eval uses it with `target_type IN ('session', 'span', 'task')`.

### 5.4 Indexes

**Source:** [`kernel/crates/gctl-storage/src/schema.rs`](../../kernel/crates/gctl-storage/src/schema.rs) — `CREATE_INDEXES` constant.

---

## 6. gctl-board Effect-TS Schemas

**Source:** [`apps/gctl-board/src/schema/`](../../apps/gctl-board/src/schema/).

| Type | File |
|------|------|
| `IssueId`, `ProjectId`, `IssueStatus`, `Priority`, `AssigneeType`, `Assignee`, `Issue`, `CreateIssueInput`, `IssueFilter` | [`Issue.ts`](../../apps/gctl-board/src/schema/Issue.ts) |
| `IssueEventType`, `IssueEvent`, `Comment` | [`IssueEvent.ts`](../../apps/gctl-board/src/schema/IssueEvent.ts) |
| `BoardId`, `Board`, `Project` | [`Board.ts`](../../apps/gctl-board/src/schema/Board.ts) |

All identifiers are `Schema.String.pipe(Schema.brand(...))` branded value objects. Enumerations use `Schema.Literal(...)`. Structures use `Schema.Struct({...})`.
