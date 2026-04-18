//! SQLite-backed store for board, inbox, persona, context, and memory data.
//!
//! This is a mechanical port of the relevant DuckDB methods from `duckdb_store.rs`,
//! using `rusqlite` instead of `duckdb`. SQLite handles board/inbox/persona/context/memory
//! while DuckDB continues to handle OTel/analytics. This enables Cloudflare D1
//! portability since D1 IS SQLite.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use gctrl_core::{
    GctlError, Result, Task,
    InboxAction, InboxActionFilter, InboxMessage, InboxMessageFilter, InboxThread,
    PersonaDefinition, PersonaReviewRule,
    context::{ContextEntry, ContextEntryId, ContextFilter, ContextKind, ContextSource},
    memory::{MemoryEntry, MemoryEntryId, MemoryFilter, MemoryStats, MemoryType},
};

// ═══════════════════════════════════════════════════════════════
// Schema (SQLite-compatible DDL)
// ═══════════════════════════════════════════════════════════════

// Board: D1-syncable tables. `device_id` + `updated_at` + `synced` are mandatory
// for the `gctrl-sync` D1 contract (see kernel/crates/gctrl-sync/src/d1.rs).
const CREATE_BOARD_PROJECTS: &str = r#"
CREATE TABLE IF NOT EXISTS board_projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL UNIQUE,
    counter     INTEGER DEFAULT 0,
    github_repo TEXT,
    device_id   TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    synced      INTEGER NOT NULL DEFAULT 0
)
"#;

const CREATE_BOARD_ISSUES: &str = r#"
CREATE TABLE IF NOT EXISTS board_issues (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'backlog',
    priority        TEXT NOT NULL DEFAULT 'none',
    assignee_id     TEXT,
    assignee_name   TEXT,
    assignee_type   TEXT,
    labels          TEXT DEFAULT '[]',
    parent_id       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    created_by_id   TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_by_type TEXT NOT NULL,
    blocked_by      TEXT DEFAULT '[]',
    blocking        TEXT DEFAULT '[]',
    session_ids     TEXT DEFAULT '[]',
    total_cost_usd  REAL DEFAULT 0.0,
    total_tokens    INTEGER DEFAULT 0,
    pr_numbers      TEXT DEFAULT '[]',
    content_hash    TEXT,
    source_path     TEXT,
    github_issue_number INTEGER,
    github_url      TEXT,
    device_id       TEXT NOT NULL DEFAULT '',
    synced          INTEGER NOT NULL DEFAULT 0
)
"#;

const CREATE_BOARD_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS board_events (
    id          TEXT PRIMARY KEY,
    issue_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    actor_id    TEXT NOT NULL,
    actor_name  TEXT NOT NULL,
    actor_type  TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    data        TEXT,
    device_id   TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    synced      INTEGER NOT NULL DEFAULT 0
)
"#;

// Scheduler primitive: Tasks are promoted from Issues on transition to
// `in_progress`. See specs/implementation/kernel/session-trigger.md §Tier 1.
const CREATE_TASKS: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT PRIMARY KEY,
    issue_id            TEXT,
    project_key         TEXT NOT NULL,
    agent_kind          TEXT NOT NULL,
    orchestrator_claim  TEXT NOT NULL DEFAULT 'Unclaimed',
    attempt             INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES board_issues(id) ON DELETE SET NULL
)
"#;

const CREATE_BOARD_COMMENTS: &str = r#"
CREATE TABLE IF NOT EXISTS board_comments (
    id          TEXT PRIMARY KEY,
    issue_id    TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_type TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    session_id  TEXT,
    device_id   TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    synced      INTEGER NOT NULL DEFAULT 0
)
"#;

const CREATE_PERSONA_DEFINITIONS: &str = r#"
CREATE TABLE IF NOT EXISTS persona_definitions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    focus           TEXT NOT NULL,
    prompt_prefix   TEXT NOT NULL,
    owns            TEXT NOT NULL,
    review_focus    TEXT NOT NULL,
    pushes_back     TEXT NOT NULL,
    tools           TEXT DEFAULT '[]',
    key_specs       TEXT DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    source_hash     TEXT
)
"#;

const CREATE_PERSONA_REVIEW_RULES: &str = r#"
CREATE TABLE IF NOT EXISTS persona_review_rules (
    id              TEXT PRIMARY KEY,
    pr_type         TEXT NOT NULL UNIQUE,
    persona_ids     TEXT NOT NULL,
    created_at      TEXT NOT NULL
)
"#;

const CREATE_INBOX_MESSAGES: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_messages (
    id              TEXT PRIMARY KEY,
    thread_id       TEXT NOT NULL,
    source          TEXT NOT NULL,
    kind            TEXT NOT NULL,
    urgency         TEXT NOT NULL DEFAULT 'medium',
    title           TEXT NOT NULL,
    body            TEXT,
    context         TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',
    requires_action INTEGER NOT NULL DEFAULT 0,
    payload         TEXT,
    duplicate_count INTEGER DEFAULT 0,
    snoozed_until   TEXT,
    expires_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
)
"#;

const CREATE_INBOX_THREADS: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_threads (
    id              TEXT PRIMARY KEY,
    context_type    TEXT NOT NULL,
    context_ref     TEXT NOT NULL,
    title           TEXT NOT NULL,
    project_key     TEXT,
    pending_count   INTEGER DEFAULT 0,
    latest_urgency  TEXT DEFAULT 'info',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
)
"#;

const CREATE_INBOX_ACTIONS: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_actions (
    id              TEXT PRIMARY KEY,
    message_id      TEXT NOT NULL,
    thread_id       TEXT NOT NULL,
    actor_id        TEXT NOT NULL,
    actor_name      TEXT NOT NULL,
    action_type     TEXT NOT NULL,
    reason          TEXT,
    metadata        TEXT,
    created_at      TEXT NOT NULL
)
"#;

const CREATE_INBOX_SUBSCRIPTIONS: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_subscriptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    filter_type     TEXT NOT NULL,
    filter_value    TEXT NOT NULL,
    enabled         INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL
)
"#;

const CREATE_CONTEXT_ENTRIES: &str = r#"
CREATE TABLE IF NOT EXISTS context_entries (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_ref      TEXT,
    word_count      INTEGER DEFAULT 0,
    content_hash    TEXT NOT NULL,
    tags            TEXT DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    synced          INTEGER DEFAULT 0
)
"#;

// Memory: D1-syncable table. `device_id` + `updated_at` + `synced` are mandatory
// for the `gctrl-sync` D1 contract (see kernel/crates/gctrl-sync/src/d1.rs).
// `name` is unique per device — upserting the same (device_id, name) overwrites.
const CREATE_MEMORY_ENTRIES: &str = r#"
CREATE TABLE IF NOT EXISTS memory_entries (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',
    device_id       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    synced          INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, name)
)
"#;

const CREATE_INDEXES: &[&str] = &[
    // Board indexes
    "CREATE INDEX IF NOT EXISTS idx_board_issues_project ON board_issues(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_status ON board_issues(status)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_assignee ON board_issues(assignee_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_parent ON board_issues(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_events_issue ON board_events(issue_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_comments_issue ON board_comments(issue_id)",
    // Board sync indexes
    "CREATE INDEX IF NOT EXISTS idx_board_projects_synced ON board_projects(synced)",
    "CREATE INDEX IF NOT EXISTS idx_board_projects_updated ON board_projects(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_synced ON board_issues(synced)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_updated ON board_issues(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_board_events_synced ON board_events(synced)",
    "CREATE INDEX IF NOT EXISTS idx_board_events_updated ON board_events(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_board_comments_synced ON board_comments(synced)",
    "CREATE INDEX IF NOT EXISTS idx_board_comments_updated ON board_comments(updated_at)",
    // Tasks indexes — promote lookup by issue, Orchestrator dispatch queue
    "CREATE INDEX IF NOT EXISTS idx_tasks_issue ON tasks(issue_id)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(orchestrator_claim)",
    // Persona indexes
    "CREATE INDEX IF NOT EXISTS idx_persona_definitions_name ON persona_definitions(name)",
    "CREATE INDEX IF NOT EXISTS idx_persona_review_rules_type ON persona_review_rules(pr_type)",
    // Inbox indexes
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread ON inbox_messages(thread_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_urgency ON inbox_messages(urgency)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_kind ON inbox_messages(kind)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_threads_context ON inbox_threads(context_type, context_ref)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_threads_project ON inbox_threads(project_key)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_actions_message ON inbox_actions(message_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_actions_actor ON inbox_actions(actor_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_subscriptions_user ON inbox_subscriptions(user_id)",
    // Context indexes
    "CREATE INDEX IF NOT EXISTS idx_context_kind ON context_entries(kind)",
    "CREATE INDEX IF NOT EXISTS idx_context_source ON context_entries(source_type)",
    "CREATE INDEX IF NOT EXISTS idx_context_path ON context_entries(path)",
    "CREATE INDEX IF NOT EXISTS idx_context_synced ON context_entries(synced)",
    // Memory indexes
    "CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type)",
    "CREATE INDEX IF NOT EXISTS idx_memory_synced ON memory_entries(synced)",
    "CREATE INDEX IF NOT EXISTS idx_memory_device ON memory_entries(device_id)",
    "CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entries(updated_at)",
];

// ═══════════════════════════════════════════════════════════════
// SqliteStore
// ═══════════════════════════════════════════════════════════════

pub struct SqliteStore {
    conn: Mutex<Connection>,
    device_id: String,
}

impl SqliteStore {
    /// Open (or create) a SQLite database at the given path with default device_id `"local"`.
    /// Pass `:memory:` for an in-memory database (useful for tests).
    pub fn open(path: &str) -> Result<Self> {
        Self::open_with_device(path, "local")
    }

    /// Open with an explicit device_id. All writes from this store stamp rows with this id.
    pub fn open_with_device(path: &str, device_id: &str) -> Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()
        } else {
            if let Some(parent) = Path::new(path).parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| GctlError::Storage(format!("create dir: {e}")))?;
            }
            Connection::open(path)
        }
        .map_err(|e| GctlError::Storage(e.to_string()))?;

        let store = Self {
            conn: Mutex::new(conn),
            device_id: device_id.to_string(),
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tables = [
            CREATE_BOARD_PROJECTS,
            CREATE_BOARD_ISSUES,
            CREATE_BOARD_EVENTS,
            CREATE_BOARD_COMMENTS,
            CREATE_TASKS,
            CREATE_PERSONA_DEFINITIONS,
            CREATE_PERSONA_REVIEW_RULES,
            CREATE_INBOX_MESSAGES,
            CREATE_INBOX_THREADS,
            CREATE_INBOX_ACTIONS,
            CREATE_INBOX_SUBSCRIPTIONS,
            CREATE_CONTEXT_ENTRIES,
            CREATE_MEMORY_ENTRIES,
        ];
        for stmt in &tables {
            conn.execute_batch(stmt)
                .map_err(|e| GctlError::Storage(format!("migration: {e}")))?;
        }
        // Idempotent ALTERs to add sync-contract columns to board tables created
        // before the sync contract existed. `ALTER TABLE ADD COLUMN` errors if the
        // column already exists — swallow only the "duplicate column name" case.
        let alters: &[&str] = &[
            "ALTER TABLE board_projects ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE board_projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
            "ALTER TABLE board_projects ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE board_issues ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE board_issues ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE board_events ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE board_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
            "ALTER TABLE board_events ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE board_comments ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE board_comments ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
            "ALTER TABLE board_comments ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
        ];
        for stmt in alters {
            if let Err(e) = conn.execute_batch(stmt) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(GctlError::Storage(format!("migration alter: {msg}")));
                }
            }
        }
        for stmt in CREATE_INDEXES {
            conn.execute_batch(stmt)
                .map_err(|e| GctlError::Storage(format!("migration: {e}")))?;
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════
    // Board CRUD
    // ═══════════════════════════════════════════════════════════════

    pub fn create_board_project(&self, project: &gctrl_core::BoardProject) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO board_projects (id, name, key, counter, github_repo, device_id, updated_at, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
            params![project.id, project.name, project.key, project.counter, project.github_repo, self.device_id, now],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_board_project(&self, id: &str) -> Result<Option<gctrl_core::BoardProject>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, key, counter, github_repo FROM board_projects WHERE id = ?1",
            [id],
            |row| {
                Ok(gctrl_core::BoardProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key: row.get(2)?,
                    counter: row.get(3)?,
                    github_repo: row.get(4)?,
                })
            },
        ).ok().map(Ok).transpose()
    }

    pub fn list_board_projects(&self) -> Result<Vec<gctrl_core::BoardProject>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, key, counter, github_repo FROM board_projects ORDER BY name")
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([], |row| {
            Ok(gctrl_core::BoardProject {
                id: row.get(0)?,
                name: row.get(1)?,
                key: row.get(2)?,
                counter: row.get(3)?,
                github_repo: row.get(4)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn update_board_project_github_repo(&self, id: &str, github_repo: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE board_projects SET github_repo = ?1, device_id = ?2, updated_at = ?3, synced = 0 WHERE id = ?4",
            params![github_repo, self.device_id, now, id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn increment_project_counter(&self, project_id: &str) -> Result<i32> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE board_projects SET counter = counter + 1, device_id = ?1, updated_at = ?2, synced = 0 WHERE id = ?3",
            params![self.device_id, now, project_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let counter: i32 = conn.query_row(
            "SELECT counter FROM board_projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(counter)
    }

    pub fn insert_board_issue(&self, issue: &gctrl_core::BoardIssue) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_issues (id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url, device_id, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
            params![
                issue.id,
                issue.project_id,
                issue.title,
                issue.description,
                issue.status.as_str(),
                issue.priority,
                issue.assignee_id,
                issue.assignee_name,
                issue.assignee_type,
                serde_json::to_string(&issue.labels).unwrap_or_else(|_| "[]".into()),
                issue.parent_id,
                issue.created_at.to_rfc3339(),
                issue.updated_at.to_rfc3339(),
                issue.created_by_id,
                issue.created_by_name,
                issue.created_by_type,
                serde_json::to_string(&issue.blocked_by).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&issue.blocking).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&issue.session_ids).unwrap_or_else(|_| "[]".into()),
                issue.total_cost_usd,
                issue.total_tokens as i64,
                serde_json::to_string(&issue.pr_numbers).unwrap_or_else(|_| "[]".into()),
                issue.content_hash,
                issue.source_path,
                issue.github_issue_number.map(|n| n as i32),
                issue.github_url,
                self.device_id,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Upsert a board issue -- insert or update if content_hash changed.
    /// Used by markdown import. Preserves session_ids, cost, and tokens from existing record.
    pub fn upsert_board_issue(&self, issue: &gctrl_core::BoardIssue) -> Result<bool> {
        // Check if exists and if content changed
        if let Some(existing) = self.get_board_issue(&issue.id)? {
            if existing.content_hash == issue.content_hash {
                return Ok(false); // No change
            }
            // Update mutable fields from markdown, preserve kernel-managed fields
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE board_issues SET title = ?1, description = ?2, status = ?3, priority = ?4,
                 assignee_id = ?5, assignee_name = ?6, assignee_type = ?7,
                 labels = ?8, parent_id = ?9, updated_at = ?10,
                 content_hash = ?11, source_path = ?12, device_id = ?13, synced = 0
                 WHERE id = ?14",
                params![
                    issue.title,
                    issue.description,
                    issue.status.as_str(),
                    issue.priority,
                    issue.assignee_id,
                    issue.assignee_name,
                    issue.assignee_type,
                    serde_json::to_string(&issue.labels).unwrap_or_else(|_| "[]".into()),
                    issue.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                    issue.content_hash,
                    issue.source_path,
                    self.device_id,
                    issue.id,
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true)
        } else {
            self.insert_board_issue(issue)?;
            Ok(true)
        }
    }

    pub fn get_board_issue(&self, id: &str) -> Result<Option<gctrl_core::BoardIssue>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url FROM board_issues WHERE id = ?1",
            [id],
            row_to_board_issue,
        ).ok().map(Ok).transpose()
    }

    pub fn list_board_issues(&self, filter: &gctrl_core::BoardIssueFilter) -> Result<Vec<gctrl_core::BoardIssue>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url FROM board_issues WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref pid) = filter.project_id {
            sql.push_str(&format!(" AND project_id = ?{}", idx));
            params_vec.push(Box::new(pid.clone()));
            idx += 1;
        }
        if let Some(ref status) = filter.status {
            sql.push_str(&format!(" AND status = ?{}", idx));
            params_vec.push(Box::new(status.clone()));
            idx += 1;
        }
        if let Some(ref aid) = filter.assignee_id {
            sql.push_str(&format!(" AND assignee_id = ?{}", idx));
            params_vec.push(Box::new(aid.clone()));
            idx += 1;
        }
        sql.push_str(" ORDER BY updated_at DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_board_issue)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn update_board_issue_status(&self, id: &str, status: &str, actor_id: &str, actor_name: &str, actor_type: &str) -> Result<()> {
        let target = gctrl_core::IssueStatus::from_str(status)
            .ok_or_else(|| GctlError::Storage(format!("invalid status: {}", status)))?;

        // Get current status
        let conn = self.conn.lock().unwrap();
        let current_str: String = conn.query_row(
            "SELECT status FROM board_issues WHERE id = ?1",
            [id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(format!("issue not found: {} ({})", id, e)))?;

        let current = gctrl_core::IssueStatus::from_str(&current_str)
            .unwrap_or(gctrl_core::IssueStatus::Backlog);

        // Compute transition path: direct if valid, otherwise auto-transit forward
        let path = if current.can_transition_to(&target) {
            vec![target]
        } else if let Some(fwd) = current.forward_path_to(&target) {
            fwd
        } else {
            return Err(GctlError::Storage(format!(
                "invalid transition: {} -> {} (allowed: {})",
                current.as_str(),
                target.as_str(),
                current.valid_transitions().iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
            )));
        };

        // Apply each step, emitting an event for every intermediate transition
        let mut prev_str = current_str;
        for step in &path {
            let now = chrono::Utc::now();
            let step_str = step.as_str();
            conn.execute(
                "UPDATE board_issues SET status = ?1, updated_at = ?2, device_id = ?3, synced = 0 WHERE id = ?4",
                params![step_str, now.to_rfc3339(), self.device_id, id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;

            let event_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO board_events (id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data, device_id, updated_at, synced)
                 VALUES (?, ?, 'status_changed', ?, ?, ?, ?, ?, ?, ?, 0)",
                params![
                    event_id, id, actor_id, actor_name, actor_type, now.to_rfc3339(),
                    serde_json::to_string(&serde_json::json!({"from": prev_str, "to": step_str})).unwrap(),
                    self.device_id, now.to_rfc3339(),
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            prev_str = step_str.to_string();
        }

        Ok(())
    }

    /// Move an Issue and — if the target is `in_progress` — promote it to a
    /// Task in the same transaction. Returns the resulting Task (or `None` for
    /// non-`in_progress` transitions). `agent_kind` is chosen by the caller
    /// (receiver.rs will resolve it from WORKFLOW.md in Tier 2).
    ///
    /// Spec: specs/implementation/kernel/session-trigger.md §Tier 1.
    pub fn update_board_issue_status_and_promote(
        &self,
        id: &str,
        status: &str,
        agent_kind: &str,
        actor_id: &str,
        actor_name: &str,
        actor_type: &str,
    ) -> Result<Option<Task>> {
        self.update_board_issue_status(id, status, actor_id, actor_name, actor_type)?;
        if status == gctrl_core::IssueStatus::InProgress.as_str() {
            let conn = self.conn.lock().unwrap();
            let task = Self::promote_issue_to_task_inner(&conn, id, agent_kind)?;
            Ok(Some(task))
        } else {
            Ok(None)
        }
    }

    /// Promote an Issue to a Task. Idempotent while the Task is non-terminal —
    /// repeated calls return the existing Task row.
    ///
    /// Spec: specs/implementation/kernel/session-trigger.md §Tier 1.
    pub fn promote_issue_to_task(&self, issue_id: &str, agent_kind: &str) -> Result<Task> {
        let conn = self.conn.lock().unwrap();
        Self::promote_issue_to_task_inner(&conn, issue_id, agent_kind)
    }

    fn promote_issue_to_task_inner(conn: &Connection, issue_id: &str, agent_kind: &str) -> Result<Task> {
        // Reuse the existing Task if one is still non-terminal.
        let existing = Self::find_nonterminal_task_for_issue(conn, issue_id)?;
        if let Some(task) = existing {
            return Ok(task);
        }

        // Look up the project key via board_issues -> board_projects.
        let project_key: String = conn
            .query_row(
                "SELECT bp.key FROM board_issues bi
                 JOIN board_projects bp ON bi.project_id = bp.id
                 WHERE bi.id = ?1",
                [issue_id],
                |row| row.get(0),
            )
            .map_err(|e| GctlError::Storage(format!("issue not found: {} ({})", issue_id, e)))?;

        let task_id = format!("TASK-{}", ulid::Ulid::new());
        let now = chrono::Utc::now();
        let now_s = now.to_rfc3339();
        conn.execute(
            "INSERT INTO tasks (id, issue_id, project_key, agent_kind, orchestrator_claim, attempt, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'Unclaimed', 0, ?, ?)",
            params![task_id, issue_id, project_key, agent_kind, now_s, now_s],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(Task {
            id: task_id,
            issue_id: Some(issue_id.to_string()),
            project_key,
            agent_kind: agent_kind.to_string(),
            orchestrator_claim: Task::CLAIM_UNCLAIMED.to_string(),
            attempt: 0,
            created_at: now,
            updated_at: now,
        })
    }

    fn find_nonterminal_task_for_issue(conn: &Connection, issue_id: &str) -> Result<Option<Task>> {
        let mut stmt = conn
            .prepare(
                "SELECT id, issue_id, project_key, agent_kind, orchestrator_claim, attempt, created_at, updated_at
                 FROM tasks WHERE issue_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map([issue_id], row_to_task)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        for row in rows {
            let task = row.map_err(|e| GctlError::Storage(e.to_string()))?;
            if Task::is_nonterminal_claim(&task.orchestrator_claim) {
                return Ok(Some(task));
            }
        }
        Ok(None)
    }

    /// List all Task rows linked to an Issue, ordered by creation time.
    pub fn list_tasks_for_issue(&self, issue_id: &str) -> Result<Vec<Task>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, issue_id, project_key, agent_kind, orchestrator_claim, attempt, created_at, updated_at
                 FROM tasks WHERE issue_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map([issue_id], row_to_task)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(|e| GctlError::Storage(e.to_string()))?);
        }
        Ok(tasks)
    }

    pub fn assign_board_issue(&self, id: &str, assignee_id: &str, assignee_name: &str, assignee_type: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE board_issues SET assignee_id = ?1, assignee_name = ?2, assignee_type = ?3, updated_at = ?4, device_id = ?5, synced = 0 WHERE id = ?6",
            params![assignee_id, assignee_name, assignee_type, now, self.device_id, id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn insert_board_event(&self, event: &gctrl_core::BoardEvent) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_events (id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data, device_id, updated_at, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
            params![
                event.id, event.issue_id, event.event_type,
                event.actor_id, event.actor_name, event.actor_type,
                event.timestamp.to_rfc3339(),
                serde_json::to_string(&event.data).unwrap_or_else(|_| "null".into()),
                self.device_id, event.timestamp.to_rfc3339(),
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn list_board_events(&self, issue_id: &str) -> Result<Vec<gctrl_core::BoardEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data FROM board_events WHERE issue_id = ?1 ORDER BY timestamp"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([issue_id], |row| {
            let ts: String = row.get(6)?;
            let data_str: String = row.get(7)?;
            Ok(gctrl_core::BoardEvent {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                event_type: row.get(2)?,
                actor_id: row.get(3)?,
                actor_name: row.get(4)?,
                actor_type: row.get(5)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                data: serde_json::from_str(&data_str).unwrap_or(serde_json::Value::Null),
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn insert_board_comment(&self, comment: &gctrl_core::BoardComment) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_comments (id, issue_id, author_id, author_name, author_type, body, created_at, session_id, device_id, updated_at, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
            params![
                comment.id, comment.issue_id,
                comment.author_id, comment.author_name, comment.author_type,
                comment.body, comment.created_at.to_rfc3339(), comment.session_id,
                self.device_id, comment.created_at.to_rfc3339(),
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn list_board_comments(&self, issue_id: &str) -> Result<Vec<gctrl_core::BoardComment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, author_id, author_name, author_type, body, created_at, session_id FROM board_comments WHERE issue_id = ?1 ORDER BY created_at"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([issue_id], |row| {
            let ts: String = row.get(6)?;
            Ok(gctrl_core::BoardComment {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                author_id: row.get(2)?,
                author_name: row.get(3)?,
                author_type: row.get(4)?,
                body: row.get(5)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                session_id: row.get(7)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn link_session_to_issue(&self, issue_id: &str, session_id: &str, cost: f64, tokens: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Read current session_ids, append, write back
        let current: String = conn.query_row(
            "SELECT session_ids FROM board_issues WHERE id = ?1",
            [issue_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut ids: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
        if !ids.contains(&session_id.to_string()) {
            ids.push(session_id.to_string());
        }
        let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());

        conn.execute(
            "UPDATE board_issues SET
                session_ids = ?1,
                total_cost_usd = total_cost_usd + ?2,
                total_tokens = total_tokens + ?3,
                updated_at = ?4,
                device_id = ?5,
                synced = 0
             WHERE id = ?6",
            params![ids_json, cost, tokens as i64, now, self.device_id, issue_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════
    // Board sync helpers (D1)
    // ═══════════════════════════════════════════════════════════════

    pub fn list_unsynced_board_projects(&self, batch_size: usize) -> Result<Vec<gctrl_core::BoardProject>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, key, counter, github_repo FROM board_projects WHERE synced = 0 ORDER BY updated_at ASC LIMIT ?1",
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([batch_size as i64], |row| {
            Ok(gctrl_core::BoardProject {
                id: row.get(0)?,
                name: row.get(1)?,
                key: row.get(2)?,
                counter: row.get(3)?,
                github_repo: row.get(4)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_unsynced_board_issues(&self, batch_size: usize) -> Result<Vec<gctrl_core::BoardIssue>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url FROM board_issues WHERE synced = 0 ORDER BY updated_at ASC LIMIT ?1",
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([batch_size as i64], row_to_board_issue)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_unsynced_board_events(&self, batch_size: usize) -> Result<Vec<gctrl_core::BoardEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data FROM board_events WHERE synced = 0 ORDER BY updated_at ASC LIMIT ?1",
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([batch_size as i64], |row| {
            let ts: String = row.get(6)?;
            let data_str: Option<String> = row.get(7)?;
            Ok(gctrl_core::BoardEvent {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                event_type: row.get(2)?,
                actor_id: row.get(3)?,
                actor_name: row.get(4)?,
                actor_type: row.get(5)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                data: data_str.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null),
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_unsynced_board_comments(&self, batch_size: usize) -> Result<Vec<gctrl_core::BoardComment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, author_id, author_name, author_type, body, created_at, session_id FROM board_comments WHERE synced = 0 ORDER BY updated_at ASC LIMIT ?1",
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([batch_size as i64], |row| {
            let ts: String = row.get(6)?;
            Ok(gctrl_core::BoardComment {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                author_id: row.get(2)?,
                author_name: row.get(3)?,
                author_type: row.get(4)?,
                body: row.get(5)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                session_id: row.get(7)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn mark_ids_synced(&self, table: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE {table} SET synced = 1 WHERE id IN ({placeholders})");
        let params_vec: Vec<&dyn rusqlite::types::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
        conn.execute(&sql, params_vec.as_slice())
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn mark_board_projects_synced(&self, ids: &[String]) -> Result<()> {
        self.mark_ids_synced("board_projects", ids)
    }

    pub fn mark_board_issues_synced(&self, ids: &[String]) -> Result<()> {
        self.mark_ids_synced("board_issues", ids)
    }

    pub fn mark_board_events_synced(&self, ids: &[String]) -> Result<()> {
        self.mark_ids_synced("board_events", ids)
    }

    pub fn mark_board_comments_synced(&self, ids: &[String]) -> Result<()> {
        self.mark_ids_synced("board_comments", ids)
    }

    /// Count unsynced board rows per table. Used by sync status reporting.
    pub fn count_unsynced_board(&self) -> Result<(u64, u64, u64, u64)> {
        let conn = self.conn.lock().unwrap();
        let count = |table: &str| -> u64 {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE synced = 0");
            conn.query_row(&sql, [], |row| row.get::<_, i64>(0)).unwrap_or(0) as u64
        };
        Ok((
            count("board_projects"),
            count("board_issues"),
            count("board_comments"),
            count("board_events"),
        ))
    }

    // ═══════════════════════════════════════════════════════════════
    // Persona CRUD
    // ═══════════════════════════════════════════════════════════════

    pub fn upsert_persona(&self, persona: &PersonaDefinition) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let tools_json = serde_json::to_string(&persona.tools).unwrap_or_else(|_| "[]".into());
        let specs_json = serde_json::to_string(&persona.key_specs).unwrap_or_else(|_| "[]".into());

        // Check if exists
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM persona_definitions WHERE id = ?1",
            [&persona.id],
            |row| row.get(0),
        ).unwrap_or(false);

        if exists {
            conn.execute(
                "UPDATE persona_definitions SET name = ?1, focus = ?2, prompt_prefix = ?3, owns = ?4, review_focus = ?5, pushes_back = ?6, tools = ?7, key_specs = ?8, updated_at = ?9, source_hash = ?10 WHERE id = ?11",
                params![persona.name, persona.focus, persona.prompt_prefix, persona.owns, persona.review_focus, persona.pushes_back, tools_json, specs_json, now, persona.source_hash, persona.id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false) // updated
        } else {
            conn.execute(
                "INSERT INTO persona_definitions (id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, created_at, updated_at, source_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![persona.id, persona.name, persona.focus, persona.prompt_prefix, persona.owns, persona.review_focus, persona.pushes_back, tools_json, specs_json, now, now, persona.source_hash],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true) // created
        }
    }

    pub fn get_persona(&self, id: &str) -> Result<Option<PersonaDefinition>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, source_hash FROM persona_definitions WHERE id = ?1",
            [id],
            |row| {
                let tools_str: String = row.get(7)?;
                let specs_str: String = row.get(8)?;
                Ok(PersonaDefinition {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    focus: row.get(2)?,
                    prompt_prefix: row.get(3)?,
                    owns: row.get(4)?,
                    review_focus: row.get(5)?,
                    pushes_back: row.get(6)?,
                    tools: serde_json::from_str(&tools_str).unwrap_or_default(),
                    key_specs: serde_json::from_str(&specs_str).unwrap_or_default(),
                    source_hash: row.get(9)?,
                })
            },
        ).ok().map(Ok).transpose()
    }

    pub fn list_personas(&self) -> Result<Vec<PersonaDefinition>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, source_hash FROM persona_definitions ORDER BY name"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut personas = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let tools_str: String = row.get(7).unwrap_or_default();
            let specs_str: String = row.get(8).unwrap_or_default();
            personas.push(PersonaDefinition {
                id: row.get(0).unwrap_or_default(),
                name: row.get(1).unwrap_or_default(),
                focus: row.get(2).unwrap_or_default(),
                prompt_prefix: row.get(3).unwrap_or_default(),
                owns: row.get(4).unwrap_or_default(),
                review_focus: row.get(5).unwrap_or_default(),
                pushes_back: row.get(6).unwrap_or_default(),
                tools: serde_json::from_str(&tools_str).unwrap_or_default(),
                key_specs: serde_json::from_str(&specs_str).unwrap_or_default(),
                source_hash: row.get(9).ok(),
            });
        }
        Ok(personas)
    }

    pub fn delete_persona(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM persona_definitions WHERE id = ?1", [id])
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(affected > 0)
    }

    pub fn upsert_review_rule(&self, rule: &PersonaReviewRule) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let ids_json = serde_json::to_string(&rule.persona_ids).unwrap_or_else(|_| "[]".into());

        // Check if exists by id
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM persona_review_rules WHERE id = ?1",
            [&rule.id],
            |row| row.get(0),
        ).unwrap_or(false);

        if exists {
            conn.execute(
                "UPDATE persona_review_rules SET pr_type = ?1, persona_ids = ?2, created_at = ?3 WHERE id = ?4",
                params![rule.pr_type, ids_json, now, rule.id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false) // updated
        } else {
            conn.execute(
                "INSERT INTO persona_review_rules (id, pr_type, persona_ids, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![rule.id, rule.pr_type, ids_json, now],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true) // created
        }
    }

    pub fn list_review_rules(&self) -> Result<Vec<PersonaReviewRule>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, pr_type, persona_ids FROM persona_review_rules ORDER BY pr_type"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rules = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let ids_str: String = row.get(2).unwrap_or_default();
            rules.push(PersonaReviewRule {
                id: row.get(0).unwrap_or_default(),
                pr_type: row.get(1).unwrap_or_default(),
                persona_ids: serde_json::from_str(&ids_str).unwrap_or_default(),
            });
        }
        Ok(rules)
    }

    pub fn get_review_rule_by_type(&self, pr_type: &str) -> Result<Option<PersonaReviewRule>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, pr_type, persona_ids FROM persona_review_rules WHERE pr_type = ?1",
            [pr_type],
            |row| {
                let ids_str: String = row.get(2)?;
                Ok(PersonaReviewRule {
                    id: row.get(0)?,
                    pr_type: row.get(1)?,
                    persona_ids: serde_json::from_str(&ids_str).unwrap_or_default(),
                })
            },
        ).ok().map(Ok).transpose()
    }

    // ═══════════════════════════════════════════════════════════════
    // Inbox application
    // ═══════════════════════════════════════════════════════════════

    pub fn get_or_create_inbox_thread(
        &self,
        context_type: &str,
        context_ref: &str,
        title: &str,
        project_key: Option<&str>,
    ) -> Result<InboxThread> {
        let conn = self.conn.lock().unwrap();
        // Try to find existing thread by context_type + context_ref
        let existing = conn.query_row(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE context_type = ?1 AND context_ref = ?2",
            params![context_type, context_ref],
            row_to_inbox_thread,
        );
        if let Ok(thread) = existing {
            return Ok(thread);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO inbox_threads (id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 'info', ?6, ?7)",
            params![id, context_type, context_ref, title, project_key, now, now],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(InboxThread {
            id,
            context_type: context_type.into(),
            context_ref: context_ref.into(),
            title: title.into(),
            project_key: project_key.map(|s| s.into()),
            pending_count: 0,
            latest_urgency: "info".into(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn create_inbox_message(&self, msg: &InboxMessage) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO inbox_messages (id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                msg.id,
                msg.thread_id,
                msg.source,
                msg.kind,
                msg.urgency,
                msg.title,
                msg.body,
                serde_json::to_string(&msg.context).unwrap_or_else(|_| "{}".into()),
                msg.status,
                msg.requires_action,
                msg.payload.as_ref().map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".into())),
                msg.duplicate_count as i32,
                msg.snoozed_until,
                msg.expires_at,
                msg.created_at,
                msg.updated_at,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Update thread pending_count and latest_urgency if message is pending
        if msg.status == "pending" {
            self.recalc_thread_counts_with_conn(&conn, &msg.thread_id)?;
        }
        Ok(())
    }

    pub fn get_inbox_message(&self, id: &str) -> Result<Option<InboxMessage>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at
             FROM inbox_messages WHERE id = ?1",
            [id],
            row_to_inbox_message,
        ).ok().map(Ok).transpose()
    }

    pub fn list_inbox_messages(&self, filter: &InboxMessageFilter) -> Result<Vec<InboxMessage>> {
        let conn = self.conn.lock().unwrap();
        let needs_join = filter.project.is_some();
        let col = |name: &str| -> String {
            if needs_join { format!("m.{}", name) } else { name.to_string() }
        };

        let base = if needs_join {
            "SELECT m.id, m.thread_id, m.source, m.kind, m.urgency, m.title, m.body, m.context, m.status, m.requires_action, m.payload, m.duplicate_count, m.snoozed_until, m.expires_at, m.created_at, m.updated_at
             FROM inbox_messages m JOIN inbox_threads t ON m.thread_id = t.id WHERE 1=1".to_string()
        } else {
            "SELECT id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at
             FROM inbox_messages WHERE 1=1".to_string()
        };

        let mut sql = base;
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref project) = filter.project {
            sql.push_str(&format!(" AND t.project_key = ?{}", idx));
            params_vec.push(Box::new(project.clone()));
            idx += 1;
        }
        if let Some(ref thread_id) = filter.thread_id {
            sql.push_str(&format!(" AND {} = ?{}", col("thread_id"), idx));
            params_vec.push(Box::new(thread_id.clone()));
            idx += 1;
        }
        if let Some(ref status) = filter.status {
            sql.push_str(&format!(" AND {} = ?{}", col("status"), idx));
            params_vec.push(Box::new(status.clone()));
            idx += 1;
        }
        if let Some(ref urgency) = filter.urgency {
            sql.push_str(&format!(" AND {} = ?{}", col("urgency"), idx));
            params_vec.push(Box::new(urgency.clone()));
            idx += 1;
        }
        if let Some(ref kind) = filter.kind {
            sql.push_str(&format!(" AND {} = ?{}", col("kind"), idx));
            params_vec.push(Box::new(kind.clone()));
            idx += 1;
        }
        if let Some(requires_action) = filter.requires_action {
            sql.push_str(&format!(" AND {} = ?{}", col("requires_action"), idx));
            params_vec.push(Box::new(requires_action));
            idx += 1;
        }
        sql.push_str(&format!(" ORDER BY {} DESC", col("created_at")));
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_message)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_inbox_thread(&self, id: &str) -> Result<Option<InboxThread>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE id = ?1",
            [id],
            row_to_inbox_thread,
        ).ok().map(Ok).transpose()
    }

    pub fn list_inbox_threads(
        &self,
        project: Option<&str>,
        has_pending: Option<bool>,
        limit: Option<usize>,
    ) -> Result<Vec<InboxThread>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(project) = project {
            sql.push_str(&format!(" AND project_key = ?{}", idx));
            params_vec.push(Box::new(project.to_string()));
            idx += 1;
        }
        if let Some(true) = has_pending {
            sql.push_str(" AND pending_count > 0");
        } else if let Some(false) = has_pending {
            sql.push_str(" AND pending_count = 0");
        }
        sql.push_str(" ORDER BY pending_count DESC, updated_at DESC");
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_thread)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn create_inbox_action(&self, action: &InboxAction) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Validate message is pending
        let status: String = conn.query_row(
            "SELECT status FROM inbox_messages WHERE id = ?1",
            [&action.message_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(format!("message not found: {}", e)))?;

        if status != "pending" {
            return Err(GctlError::Storage(format!(
                "cannot act on message with status '{}' (expected 'pending')",
                status
            )));
        }

        // Insert action
        conn.execute(
            "INSERT INTO inbox_actions (id, message_id, thread_id, actor_id, actor_name, action_type, reason, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                action.id,
                action.message_id,
                action.thread_id,
                action.actor_id,
                action.actor_name,
                action.action_type,
                action.reason,
                action.metadata.as_ref().map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".into())),
                action.created_at,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Update message status to 'acted'
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE inbox_messages SET status = 'acted', updated_at = ?1 WHERE id = ?2",
            params![now, action.message_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Recalc thread counts
        self.recalc_thread_counts_with_conn(&conn, &action.thread_id)?;

        Ok(())
    }

    pub fn list_inbox_actions(&self, filter: &InboxActionFilter) -> Result<Vec<InboxAction>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, message_id, thread_id, actor_id, actor_name, action_type, reason, metadata, created_at
             FROM inbox_actions WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref actor_id) = filter.actor_id {
            sql.push_str(&format!(" AND actor_id = ?{}", idx));
            params_vec.push(Box::new(actor_id.clone()));
            idx += 1;
        }
        if let Some(ref since) = filter.since {
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            params_vec.push(Box::new(since.clone()));
            idx += 1;
        }
        if let Some(ref thread_id) = filter.thread_id {
            sql.push_str(&format!(" AND thread_id = ?{}", idx));
            params_vec.push(Box::new(thread_id.clone()));
            idx += 1;
        }
        sql.push_str(" ORDER BY created_at DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_action)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn recalc_thread_counts(&self, thread_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        self.recalc_thread_counts_with_conn(&conn, thread_id)
    }

    fn recalc_thread_counts_with_conn(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<()> {
        let pending_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE thread_id = ?1 AND status = 'pending'",
            [thread_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Compute latest_urgency as the highest urgency among pending messages
        let urgency_order = ["critical", "high", "medium", "low", "info"];
        let latest_urgency = if pending_count > 0 {
            let mut best = "info";
            let mut stmt = conn.prepare(
                "SELECT DISTINCT urgency FROM inbox_messages WHERE thread_id = ?1 AND status = 'pending'"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([thread_id]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let u: String = row.get(0).unwrap_or_default();
                let u_pos = urgency_order.iter().position(|&x| x == u).unwrap_or(4);
                let best_pos = urgency_order.iter().position(|&x| x == best).unwrap_or(4);
                if u_pos < best_pos {
                    best = urgency_order[u_pos];
                }
            }
            best
        } else {
            "info"
        };

        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE inbox_threads SET pending_count = ?1, latest_urgency = ?2, updated_at = ?3 WHERE id = ?4",
            params![pending_count, latest_urgency, now, thread_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(())
    }

    pub fn get_inbox_stats(&self) -> Result<serde_json::Value> {
        let conn = self.conn.lock().unwrap();

        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages", [], |row| row.get(0),
        ).unwrap_or(0);

        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE status = 'pending'", [], |row| row.get(0),
        ).unwrap_or(0);

        let acted: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE status = 'acted'", [], |row| row.get(0),
        ).unwrap_or(0);

        // By urgency (pending only)
        let mut by_urgency = serde_json::Map::new();
        {
            let mut stmt = conn.prepare(
                "SELECT urgency, COUNT(*) FROM inbox_messages WHERE status = 'pending' GROUP BY urgency"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let urgency: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_urgency.insert(urgency, serde_json::Value::Number(count.into()));
            }
        }

        // By kind (pending only)
        let mut by_kind = serde_json::Map::new();
        {
            let mut stmt = conn.prepare(
                "SELECT kind, COUNT(*) FROM inbox_messages WHERE status = 'pending' GROUP BY kind"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let kind: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_kind.insert(kind, serde_json::Value::Number(count.into()));
            }
        }

        Ok(serde_json::json!({
            "total": total,
            "pending": pending,
            "acted": acted,
            "by_urgency": by_urgency,
            "by_kind": by_kind,
        }))
    }

    // ═══════════════════════════════════════════════════════════════
    // Context CRUD
    // ═══════════════════════════════════════════════════════════════

    /// Upsert a context entry by path. Returns true if created, false if updated (no change returns false).
    pub fn upsert_context_entry(
        &self,
        id: &str,
        kind: &str,
        path: &str,
        title: &str,
        source_type: &str,
        source_ref: Option<&str>,
        word_count: i32,
        content_hash: &str,
        tags: &[String],
        created_at: &str,
        updated_at: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".into());

        // Check if entry exists by path
        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM context_entries WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .ok();

        if let Some(_) = existing_id {
            conn.execute(
                "UPDATE context_entries SET title = ?1, kind = ?2, source_type = ?3, source_ref = ?4,
                 word_count = ?5, content_hash = ?6, tags = ?7, updated_at = ?8, synced = 0
                 WHERE path = ?9",
                params![title, kind, source_type, source_ref, word_count, content_hash, tags_json, updated_at, path],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false) // updated
        } else {
            conn.execute(
                "INSERT INTO context_entries (id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
                params![id, kind, path, title, source_type, source_ref, word_count, content_hash, tags_json, created_at, updated_at],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true) // created
        }
    }

    pub fn get_context_entry(&self, id: &str) -> Result<Option<ContextEntry>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced FROM context_entries WHERE id = ?1",
            [id],
            row_to_context_entry,
        ).ok().map(Ok).transpose()
    }

    pub fn list_context_entries(&self, filter: &ContextFilter) -> Result<Vec<ContextEntry>> {
        let conn = self.conn.lock().unwrap();

        let mut sql = String::from(
            "SELECT id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced FROM context_entries WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref kind) = filter.kind {
            sql.push_str(&format!(" AND kind = ?{}", idx));
            params_vec.push(Box::new(kind.as_str().to_string()));
            idx += 1;
        }

        if let Some(ref source) = filter.source {
            sql.push_str(&format!(" AND source_type = ?{}", idx));
            params_vec.push(Box::new(source.clone()));
            idx += 1;
        }

        if let Some(ref search) = filter.search {
            sql.push_str(&format!(" AND (title LIKE ?{0} OR path LIKE ?{0})", idx));
            params_vec.push(Box::new(format!("%{}%", search)));
            idx += 1;
        }

        sql.push_str(" ORDER BY updated_at DESC");

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let entries = stmt
            .query_map(param_refs.as_slice(), row_to_context_entry)
            .map_err(|e| GctlError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();

        // Post-filter by tag (SQLite JSON array filtering is simpler in Rust)
        let entries = if let Some(ref tag) = filter.tag {
            entries.into_iter().filter(|e| e.tags.contains(tag)).collect()
        } else {
            entries
        };

        Ok(entries)
    }

    pub fn remove_context_entry(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM context_entries WHERE id = ?1", [id])
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(affected > 0)
    }

    pub fn get_context_stats(&self) -> Result<serde_json::Value> {
        let conn = self.conn.lock().unwrap();

        let total_entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM context_entries", [], |row| row.get(0))
            .unwrap_or(0);

        let total_words: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM context_entries",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut by_kind = serde_json::Map::new();
        {
            let mut stmt = conn.prepare("SELECT kind, COUNT(*) FROM context_entries GROUP BY kind ORDER BY kind")
                .map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let kind: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_kind.insert(kind, serde_json::Value::Number(count.into()));
            }
        }

        let mut by_source = serde_json::Map::new();
        {
            let mut stmt = conn.prepare("SELECT source_type, COUNT(*) FROM context_entries GROUP BY source_type ORDER BY source_type")
                .map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let source: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_source.insert(source, serde_json::Value::Number(count.into()));
            }
        }

        Ok(serde_json::json!({
            "total_entries": total_entries,
            "total_words": total_words,
            "by_kind": by_kind,
            "by_source": by_source,
        }))
    }

    // ═══════════════════════════════════════════════════════════════
    // Memory CRUD
    // ═══════════════════════════════════════════════════════════════

    /// Upsert a memory entry by `(device_id, name)`. Returns true if created, false if updated.
    /// Any update resets `synced = 0` so the sync engine will re-push the row.
    pub fn upsert_memory(&self, entry: &MemoryEntry) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let tags_json = serde_json::to_string(&entry.tags).unwrap_or_else(|_| "[]".into());

        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM memory_entries WHERE device_id = ?1 AND name = ?2",
                params![entry.device_id, entry.name],
                |row| row.get(0),
            )
            .ok();

        if existing_id.is_some() {
            conn.execute(
                "UPDATE memory_entries SET type = ?1, description = ?2, body = ?3, tags = ?4,
                 updated_at = ?5, synced = 0
                 WHERE device_id = ?6 AND name = ?7",
                params![
                    entry.memory_type.as_str(),
                    entry.description,
                    entry.body,
                    tags_json,
                    entry.updated_at.to_rfc3339(),
                    entry.device_id,
                    entry.name,
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT INTO memory_entries (id, type, name, description, body, tags, device_id, created_at, updated_at, synced)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)",
                params![
                    entry.id.0,
                    entry.memory_type.as_str(),
                    entry.name,
                    entry.description,
                    entry.body,
                    tags_json,
                    entry.device_id,
                    entry.created_at.to_rfc3339(),
                    entry.updated_at.to_rfc3339(),
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true)
        }
    }

    pub fn get_memory(&self, id: &str) -> Result<Option<MemoryEntry>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, type, name, description, body, tags, device_id, created_at, updated_at, synced FROM memory_entries WHERE id = ?1",
            [id],
            row_to_memory_entry,
        ).ok().map(Ok).transpose()
    }

    pub fn list_memories(&self, filter: &MemoryFilter) -> Result<Vec<MemoryEntry>> {
        let conn = self.conn.lock().unwrap();

        let mut sql = String::from(
            "SELECT id, type, name, description, body, tags, device_id, created_at, updated_at, synced FROM memory_entries WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref ty) = filter.memory_type {
            sql.push_str(&format!(" AND type = ?{}", idx));
            params_vec.push(Box::new(ty.as_str().to_string()));
            idx += 1;
        }
        if let Some(ref search) = filter.search {
            sql.push_str(&format!(
                " AND (name LIKE ?{0} OR description LIKE ?{0} OR body LIKE ?{0})",
                idx
            ));
            params_vec.push(Box::new(format!("%{}%", search)));
            idx += 1;
        }

        sql.push_str(" ORDER BY updated_at DESC");

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let entries = stmt
            .query_map(param_refs.as_slice(), row_to_memory_entry)
            .map_err(|e| GctlError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();

        let entries = if let Some(ref tag) = filter.tag {
            entries.into_iter().filter(|e| e.tags.contains(tag)).collect()
        } else {
            entries
        };

        Ok(entries)
    }

    pub fn remove_memory(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn
            .execute("DELETE FROM memory_entries WHERE id = ?1", [id])
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(affected > 0)
    }

    pub fn get_memory_stats(&self) -> Result<MemoryStats> {
        let conn = self.conn.lock().unwrap();

        let total_entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_entries", [], |row| row.get(0))
            .unwrap_or(0);

        let unsynced: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_entries WHERE synced = 0", [], |row| row.get(0))
            .unwrap_or(0);

        let mut by_type = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT type, COUNT(*) FROM memory_entries GROUP BY type ORDER BY type")
                .map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let ty: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_type.push((ty, count as u64));
            }
        }

        Ok(MemoryStats {
            total_entries: total_entries as u64,
            by_type,
            unsynced: unsynced as u64,
        })
    }

    /// Fetch unsynced memory rows for the sync engine. Limited by `batch_size` to
    /// keep D1 payloads bounded.
    pub fn list_unsynced_memories(&self, batch_size: usize) -> Result<Vec<MemoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, type, name, description, body, tags, device_id, created_at, updated_at, synced
             FROM memory_entries WHERE synced = 0 ORDER BY updated_at ASC LIMIT ?1",
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map([batch_size as i64], row_to_memory_entry)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Mark a set of memory rows as synced after a successful D1 push.
    pub fn mark_memories_synced(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE memory_entries SET synced = 1 WHERE id IN ({placeholders})");
        let params_vec: Vec<&dyn rusqlite::types::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
        conn.execute(&sql, params_vec.as_slice())
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════
// Row mapping helpers
// ═══════════════════════════════════════════════════════════════

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let created_at_str: String = row.get(6)?;
    let updated_at_str: String = row.get(7)?;
    Ok(Task {
        id: row.get(0)?,
        issue_id: row.get(1)?,
        project_key: row.get(2)?,
        agent_kind: row.get(3)?,
        orchestrator_claim: row.get(4)?,
        attempt: row.get(5)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}

fn row_to_board_issue(row: &rusqlite::Row<'_>) -> rusqlite::Result<gctrl_core::BoardIssue> {
    let status_str: String = row.get(4)?;
    let labels_str: String = row.get(9)?;
    let created_at_str: String = row.get(11)?;
    let updated_at_str: String = row.get(12)?;
    let blocked_by_str: String = row.get(16)?;
    let blocking_str: String = row.get(17)?;
    let session_ids_str: String = row.get(18)?;
    let pr_numbers_str: String = row.get(21)?;

    Ok(gctrl_core::BoardIssue {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        status: gctrl_core::IssueStatus::from_str(&status_str).unwrap_or(gctrl_core::IssueStatus::Backlog),
        priority: row.get(5)?,
        assignee_id: row.get(6)?,
        assignee_name: row.get(7)?,
        assignee_type: row.get(8)?,
        labels: serde_json::from_str(&labels_str).unwrap_or_default(),
        parent_id: row.get(10)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        created_by_id: row.get(13)?,
        created_by_name: row.get(14)?,
        created_by_type: row.get(15)?,
        blocked_by: serde_json::from_str(&blocked_by_str).unwrap_or_default(),
        blocking: serde_json::from_str(&blocking_str).unwrap_or_default(),
        session_ids: serde_json::from_str(&session_ids_str).unwrap_or_default(),
        total_cost_usd: row.get(19)?,
        total_tokens: { let v: i64 = row.get(20)?; v as u64 },
        pr_numbers: serde_json::from_str(&pr_numbers_str).unwrap_or_default(),
        content_hash: row.get(22)?,
        source_path: row.get(23)?,
        github_issue_number: { let v: Option<i32> = row.get(24)?; v.map(|n| n as u32) },
        github_url: row.get(25)?,
    })
}

fn row_to_inbox_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxMessage> {
    let context_str: String = row.get(7)?;
    let payload_str: Option<String> = row.get(10)?;
    Ok(InboxMessage {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        source: row.get(2)?,
        kind: row.get(3)?,
        urgency: row.get(4)?,
        title: row.get(5)?,
        body: row.get(6)?,
        context: serde_json::from_str(&context_str).unwrap_or(serde_json::json!({})),
        status: row.get(8)?,
        requires_action: row.get(9)?,
        payload: payload_str.and_then(|s| serde_json::from_str(&s).ok()),
        duplicate_count: { let v: i32 = row.get(11)?; v as u32 },
        snoozed_until: row.get(12)?,
        expires_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn row_to_inbox_thread(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxThread> {
    Ok(InboxThread {
        id: row.get(0)?,
        context_type: row.get(1)?,
        context_ref: row.get(2)?,
        title: row.get(3)?,
        project_key: row.get(4)?,
        pending_count: row.get(5)?,
        latest_urgency: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_inbox_action(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxAction> {
    let metadata_str: Option<String> = row.get(7)?;
    Ok(InboxAction {
        id: row.get(0)?,
        message_id: row.get(1)?,
        thread_id: row.get(2)?,
        actor_id: row.get(3)?,
        actor_name: row.get(4)?,
        action_type: row.get(5)?,
        reason: row.get(6)?,
        metadata: metadata_str.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: row.get(8)?,
    })
}

fn row_to_context_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextEntry> {
    let id: String = row.get(0)?;
    let kind_str: String = row.get(1)?;
    let path: String = row.get(2)?;
    let title: String = row.get(3)?;
    let source_type: String = row.get(4)?;
    let source_ref: Option<String> = row.get(5)?;
    let word_count: i32 = row.get(6)?;
    let content_hash: String = row.get(7)?;
    let tags_json: String = row.get(8)?;
    let created_at: String = row.get(9)?;
    let updated_at: String = row.get(10)?;
    let synced: bool = row.get(11)?;

    let kind = ContextKind::from_str(&kind_str).unwrap_or(ContextKind::Document);
    let source = ContextSource::from_parts(&source_type, source_ref.as_deref());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(ContextEntry {
        id: ContextEntryId(id),
        kind,
        path,
        title,
        source,
        word_count: word_count as usize,
        content_hash,
        tags,
        created_at,
        updated_at,
        synced,
    })
}

fn row_to_memory_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
    let id: String = row.get(0)?;
    let type_str: String = row.get(1)?;
    let name: String = row.get(2)?;
    let description: String = row.get(3)?;
    let body: String = row.get(4)?;
    let tags_json: String = row.get(5)?;
    let device_id: String = row.get(6)?;
    let created_at: String = row.get(7)?;
    let updated_at: String = row.get(8)?;
    let synced: bool = row.get(9)?;

    let memory_type = MemoryType::from_str(&type_str).unwrap_or(MemoryType::Reference);
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(MemoryEntry {
        id: MemoryEntryId(id),
        memory_type,
        name,
        description,
        body,
        tags,
        device_id,
        created_at,
        updated_at,
        synced,
    })
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctrl_core::*;

    fn test_store() -> SqliteStore {
        SqliteStore::open(":memory:").unwrap()
    }

    #[test]
    fn test_open_in_memory() {
        let store = SqliteStore::open(":memory:");
        assert!(store.is_ok());
    }

    #[test]
    fn test_create_and_list_board_projects() {
        let store = test_store();

        let project = BoardProject {
            id: "proj-1".into(),
            name: "Alpha".into(),
            key: "ALPHA".into(),
            counter: 0,
            github_repo: Some("org/alpha".into()),
        };
        store.create_board_project(&project).unwrap();

        let project2 = BoardProject {
            id: "proj-2".into(),
            name: "Beta".into(),
            key: "BETA".into(),
            counter: 0,
            github_repo: None,
        };
        store.create_board_project(&project2).unwrap();

        let projects = store.list_board_projects().unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name, "Alpha");
        assert_eq!(projects[1].name, "Beta");

        // Get by id
        let fetched = store.get_board_project("proj-1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().key, "ALPHA");

        // Increment counter
        let counter = store.increment_project_counter("proj-1").unwrap();
        assert_eq!(counter, 1);
        let counter = store.increment_project_counter("proj-1").unwrap();
        assert_eq!(counter, 2);
    }

    #[test]
    fn test_create_and_get_board_issue() {
        let store = test_store();

        let project = BoardProject {
            id: "proj-1".into(),
            name: "Test".into(),
            key: "TEST".into(),
            counter: 0,
            github_repo: None,
        };
        store.create_board_project(&project).unwrap();

        let now = Utc::now();
        let issue = BoardIssue {
            id: "TEST-1".into(),
            project_id: "proj-1".into(),
            title: "Fix the bug".into(),
            description: Some("It crashes on startup".into()),
            status: IssueStatus::Backlog,
            priority: "high".into(),
            assignee_id: None,
            assignee_name: None,
            assignee_type: None,
            labels: vec!["bug".into()],
            parent_id: None,
            created_at: now,
            updated_at: now,
            created_by_id: "user-1".into(),
            created_by_name: "Alice".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: Some("abc123".into()),
            source_path: None,
            github_issue_number: None,
            github_url: None,
        };
        store.insert_board_issue(&issue).unwrap();

        let fetched = store.get_board_issue("TEST-1").unwrap();
        assert!(fetched.is_some());
        let fetched = fetched.unwrap();
        assert_eq!(fetched.title, "Fix the bug");
        assert_eq!(fetched.status, IssueStatus::Backlog);
        assert_eq!(fetched.labels, vec!["bug".to_string()]);

        // List with filter
        let filter = BoardIssueFilter {
            project_id: Some("proj-1".into()),
            ..Default::default()
        };
        let issues = store.list_board_issues(&filter).unwrap();
        assert_eq!(issues.len(), 1);

        // Update status
        store.update_board_issue_status("TEST-1", "todo", "user-1", "Alice", "human").unwrap();
        let updated = store.get_board_issue("TEST-1").unwrap().unwrap();
        assert_eq!(updated.status, IssueStatus::Todo);
    }

    #[test]
    fn test_create_and_list_inbox_messages() {
        let store = test_store();

        let thread = store.get_or_create_inbox_thread(
            "pr", "org/repo#42", "PR #42: Fix stuff", Some("BOARD"),
        ).unwrap();
        assert_eq!(thread.context_type, "pr");
        assert_eq!(thread.pending_count, 0);

        let now = Utc::now().to_rfc3339();
        let msg = InboxMessage {
            id: "msg-1".into(),
            thread_id: thread.id.clone(),
            source: "github".into(),
            kind: "pr_review".into(),
            urgency: "high".into(),
            title: "Review requested".into(),
            body: Some("Please review this PR".into()),
            context: serde_json::json!({"pr_number": 42}),
            status: "pending".into(),
            requires_action: true,
            payload: None,
            duplicate_count: 0,
            snoozed_until: None,
            expires_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        store.create_inbox_message(&msg).unwrap();

        let fetched = store.get_inbox_message("msg-1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().title, "Review requested");

        // Thread should have been updated
        let thread = store.get_inbox_thread(&thread.id).unwrap().unwrap();
        assert_eq!(thread.pending_count, 1);
        assert_eq!(thread.latest_urgency, "high");

        // List messages
        let filter = InboxMessageFilter {
            status: Some("pending".into()),
            ..Default::default()
        };
        let messages = store.list_inbox_messages(&filter).unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_upsert_persona() {
        let store = test_store();

        let persona = PersonaDefinition {
            id: "persona-arch".into(),
            name: "Architect".into(),
            focus: "System design".into(),
            prompt_prefix: "You are a senior architect...".into(),
            owns: "specs/".into(),
            review_focus: "Architecture decisions".into(),
            pushes_back: "Over-engineering".into(),
            tools: vec!["read".into(), "write".into()],
            key_specs: vec!["specs/arch.md".into()],
            source_hash: Some("hash123".into()),
        };

        // Create
        let created = store.upsert_persona(&persona).unwrap();
        assert!(created);

        // Read back
        let fetched = store.get_persona("persona-arch").unwrap();
        assert!(fetched.is_some());
        let fetched = fetched.unwrap();
        assert_eq!(fetched.name, "Architect");
        assert_eq!(fetched.tools, vec!["read".to_string(), "write".to_string()]);

        // Update
        let mut updated = persona.clone();
        updated.focus = "System design and scalability".into();
        let was_new = store.upsert_persona(&updated).unwrap();
        assert!(!was_new); // updated, not created

        let fetched = store.get_persona("persona-arch").unwrap().unwrap();
        assert_eq!(fetched.focus, "System design and scalability");

        // List
        let all = store.list_personas().unwrap();
        assert_eq!(all.len(), 1);

        // Delete
        let deleted = store.delete_persona("persona-arch").unwrap();
        assert!(deleted);
        assert!(store.get_persona("persona-arch").unwrap().is_none());
    }

    #[test]
    fn test_context_entry_crud() {
        let store = test_store();
        let now = Utc::now().to_rfc3339();

        // Create
        let created = store.upsert_context_entry(
            "ctx-1", "document", "notes/test.md", "Test Note",
            "human", None, 42, "hash123",
            &["test".into()], &now, &now,
        ).unwrap();
        assert!(created);

        // Get
        let fetched = store.get_context_entry("ctx-1").unwrap();
        assert!(fetched.is_some());
        let fetched = fetched.unwrap();
        assert_eq!(fetched.path, "notes/test.md");
        assert_eq!(fetched.title, "Test Note");
        assert_eq!(fetched.word_count, 42);
        assert_eq!(fetched.tags, vec!["test".to_string()]);

        // Upsert (update by path)
        let updated = store.upsert_context_entry(
            "ctx-1", "document", "notes/test.md", "Updated Title",
            "human", None, 50, "hash456",
            &["test".into(), "updated".into()], &now, &now,
        ).unwrap();
        assert!(!updated); // was update, not create

        let fetched = store.get_context_entry("ctx-1").unwrap().unwrap();
        assert_eq!(fetched.title, "Updated Title");
        assert_eq!(fetched.word_count, 50);

        // List
        let all = store.list_context_entries(&ContextFilter::default()).unwrap();
        assert_eq!(all.len(), 1);

        // Remove
        let removed = store.remove_context_entry("ctx-1").unwrap();
        assert!(removed);
        assert!(store.get_context_entry("ctx-1").unwrap().is_none());
    }

    #[test]
    fn test_context_stats() {
        let store = test_store();
        let now = Utc::now().to_rfc3339();

        store.upsert_context_entry(
            "ctx-1", "document", "a.md", "A", "human", None, 10, "h1", &[], &now, &now,
        ).unwrap();
        store.upsert_context_entry(
            "ctx-2", "config", "b.md", "B", "system", Some("board"), 20, "h2", &[], &now, &now,
        ).unwrap();

        let stats = store.get_context_stats().unwrap();
        assert_eq!(stats["total_entries"], 2);
        assert_eq!(stats["total_words"], 30);
    }

    fn make_memory(name: &str, ty: MemoryType, device: &str) -> MemoryEntry {
        let now = Utc::now();
        MemoryEntry {
            id: MemoryEntryId(format!("mem-{device}-{name}")),
            memory_type: ty,
            name: name.into(),
            description: format!("desc for {name}"),
            body: format!("body for {name}"),
            tags: vec!["t1".into()],
            device_id: device.into(),
            created_at: now,
            updated_at: now,
            synced: false,
        }
    }

    #[test]
    fn test_memory_crud() {
        let store = test_store();
        let entry = make_memory("no_bun", MemoryType::Feedback, "dev-a");

        let created = store.upsert_memory(&entry).unwrap();
        assert!(created);

        let fetched = store.get_memory(&entry.id.0).unwrap().unwrap();
        assert_eq!(fetched.name, "no_bun");
        assert_eq!(fetched.memory_type, MemoryType::Feedback);
        assert_eq!(fetched.tags, vec!["t1".to_string()]);
        assert!(!fetched.synced);

        // Upsert same (device_id, name) updates, preserves id.
        let mut updated = entry.clone();
        updated.body = "updated body".into();
        updated.id = MemoryEntryId("mem-different".into()); // ignored; upsert finds by (device,name)
        let was_new = store.upsert_memory(&updated).unwrap();
        assert!(!was_new);
        let fetched = store.get_memory(&entry.id.0).unwrap().unwrap();
        assert_eq!(fetched.body, "updated body");

        let removed = store.remove_memory(&entry.id.0).unwrap();
        assert!(removed);
        assert!(store.get_memory(&entry.id.0).unwrap().is_none());
    }

    #[test]
    fn test_memory_list_and_filter() {
        let store = test_store();
        store.upsert_memory(&make_memory("m_user", MemoryType::User, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("m_fb", MemoryType::Feedback, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("m_ref", MemoryType::Reference, "dev-a")).unwrap();

        let all = store.list_memories(&MemoryFilter::default()).unwrap();
        assert_eq!(all.len(), 3);

        let fb_only = store.list_memories(&MemoryFilter {
            memory_type: Some(MemoryType::Feedback),
            ..Default::default()
        }).unwrap();
        assert_eq!(fb_only.len(), 1);
        assert_eq!(fb_only[0].name, "m_fb");

        let searched = store.list_memories(&MemoryFilter {
            search: Some("user".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(searched.len(), 1);
        assert_eq!(searched[0].name, "m_user");
    }

    #[test]
    fn test_memory_unique_per_device() {
        let store = test_store();
        store.upsert_memory(&make_memory("shared_name", MemoryType::Project, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("shared_name", MemoryType::Project, "dev-b")).unwrap();

        let all = store.list_memories(&MemoryFilter::default()).unwrap();
        assert_eq!(all.len(), 2, "same name on different devices must coexist");
    }

    #[test]
    fn test_memory_sync_roundtrip() {
        let store = test_store();
        store.upsert_memory(&make_memory("a", MemoryType::User, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("b", MemoryType::User, "dev-a")).unwrap();

        let pending = store.list_unsynced_memories(100).unwrap();
        assert_eq!(pending.len(), 2);

        let ids: Vec<String> = pending.iter().map(|m| m.id.0.clone()).collect();
        store.mark_memories_synced(&ids).unwrap();

        let pending = store.list_unsynced_memories(100).unwrap();
        assert!(pending.is_empty());

        // Update bumps synced back to 0.
        let updated = make_memory("a", MemoryType::User, "dev-a");
        store.upsert_memory(&updated).unwrap();
        let pending = store.list_unsynced_memories(100).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].name, "a");
    }

    #[test]
    fn test_memory_stats() {
        let store = test_store();
        store.upsert_memory(&make_memory("u1", MemoryType::User, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("u2", MemoryType::User, "dev-a")).unwrap();
        store.upsert_memory(&make_memory("f1", MemoryType::Feedback, "dev-a")).unwrap();

        let stats = store.get_memory_stats().unwrap();
        assert_eq!(stats.total_entries, 3);
        assert_eq!(stats.unsynced, 3);
        let user_count = stats.by_type.iter().find(|(k, _)| k == "user").map(|(_, v)| *v);
        assert_eq!(user_count, Some(2));
    }

    fn make_issue(id: &str, project_id: &str) -> BoardIssue {
        let now = Utc::now();
        BoardIssue {
            id: id.into(),
            project_id: project_id.into(),
            title: format!("Issue {id}"),
            description: None,
            status: IssueStatus::Backlog,
            priority: "none".into(),
            assignee_id: None,
            assignee_name: None,
            assignee_type: None,
            labels: vec![],
            parent_id: None,
            created_at: now,
            updated_at: now,
            created_by_id: "u".into(),
            created_by_name: "u".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: Some(id.into()),
            source_path: None,
            github_issue_number: None,
            github_url: None,
        }
    }

    #[test]
    fn board_writes_stamp_device_and_unsynced() {
        let store = SqliteStore::open_with_device(":memory:", "dev-1").unwrap();
        store.create_board_project(&BoardProject {
            id: "p1".into(),
            name: "P".into(),
            key: "P".into(),
            counter: 0,
            github_repo: None,
        }).unwrap();
        store.insert_board_issue(&make_issue("P-1", "p1")).unwrap();

        let projects = store.list_unsynced_board_projects(10).unwrap();
        assert_eq!(projects.len(), 1, "project should be unsynced after insert");

        let issues = store.list_unsynced_board_issues(10).unwrap();
        assert_eq!(issues.len(), 1, "issue should be unsynced after insert");
        assert_eq!(issues[0].id, "P-1");

        let (proj_n, issue_n, comment_n, event_n) = store.count_unsynced_board().unwrap();
        assert_eq!((proj_n, issue_n, comment_n, event_n), (1, 1, 0, 0));
    }

    #[test]
    fn board_round_trip_mark_synced() {
        let store = SqliteStore::open_with_device(":memory:", "dev-1").unwrap();
        store.create_board_project(&BoardProject {
            id: "p1".into(),
            name: "P".into(),
            key: "P".into(),
            counter: 0,
            github_repo: None,
        }).unwrap();
        store.insert_board_issue(&make_issue("P-1", "p1")).unwrap();

        // Status change emits an event AND bumps issue updated_at.
        store.update_board_issue_status("P-1", "todo", "u", "u", "human").unwrap();

        let comment = BoardComment {
            id: "c1".into(),
            issue_id: "P-1".into(),
            author_id: "u".into(),
            author_name: "u".into(),
            author_type: "human".into(),
            body: "hi".into(),
            created_at: Utc::now(),
            session_id: None,
        };
        store.insert_board_comment(&comment).unwrap();

        // Fetch unsynced, mark them, expect zero unsynced after.
        let projects: Vec<String> = store.list_unsynced_board_projects(10).unwrap()
            .into_iter().map(|p| p.id).collect();
        let issues: Vec<String> = store.list_unsynced_board_issues(10).unwrap()
            .into_iter().map(|i| i.id).collect();
        let events: Vec<String> = store.list_unsynced_board_events(10).unwrap()
            .into_iter().map(|e| e.id).collect();
        let comments: Vec<String> = store.list_unsynced_board_comments(10).unwrap()
            .into_iter().map(|c| c.id).collect();

        assert!(!projects.is_empty());
        assert!(!issues.is_empty());
        assert!(!events.is_empty(), "status change should produce an event");
        assert_eq!(comments.len(), 1);

        store.mark_board_projects_synced(&projects).unwrap();
        store.mark_board_issues_synced(&issues).unwrap();
        store.mark_board_events_synced(&events).unwrap();
        store.mark_board_comments_synced(&comments).unwrap();

        let (p, i, c, e) = store.count_unsynced_board().unwrap();
        assert_eq!((p, i, c, e), (0, 0, 0, 0));
    }

    #[test]
    fn board_update_resets_synced_flag() {
        let store = SqliteStore::open_with_device(":memory:", "dev-1").unwrap();
        store.create_board_project(&BoardProject {
            id: "p1".into(),
            name: "P".into(),
            key: "P".into(),
            counter: 0,
            github_repo: None,
        }).unwrap();
        store.insert_board_issue(&make_issue("P-1", "p1")).unwrap();

        let issues: Vec<String> = store.list_unsynced_board_issues(10).unwrap()
            .into_iter().map(|i| i.id).collect();
        store.mark_board_issues_synced(&issues).unwrap();
        assert_eq!(store.list_unsynced_board_issues(10).unwrap().len(), 0);

        // A subsequent local edit must mark the row unsynced again.
        store.assign_board_issue("P-1", "u2", "User 2", "human").unwrap();
        assert_eq!(store.list_unsynced_board_issues(10).unwrap().len(), 1);
    }
}
