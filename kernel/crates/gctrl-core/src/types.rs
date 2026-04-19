use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// --- Identifiers ---

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DeviceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TraceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpanId(pub String);

// --- Session ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SessionStatus {
    Active,
    Completed,
    Failed,
    Cancelled,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

// --- Task (Scheduler) ---
//
// A Task is the Scheduler's unit of dispatchable work. Issues (app-level,
// human-managed) are promoted to Tasks when they transition to `in_progress`
// on the board. The Orchestrator only ever sees Tasks; it never reads Issues.
//
// `orchestrator_claim` is stored as a string — the full claim-state machine
// (Unclaimed → Claimed → Running → RetryQueued → Released) lives in the
// `gctrl-orch` crate and will land alongside the orchestrator stub.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub issue_id: Option<String>,
    pub project_key: String,
    pub attempt_ordinal: i32,
    pub agent_kind: String,
    pub orchestrator_claim: String,
    pub attempt: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Task {
    pub const CLAIM_UNCLAIMED: &'static str = "Unclaimed";
    pub const CLAIM_CLAIMED: &'static str = "Claimed";
    pub const CLAIM_RUNNING: &'static str = "Running";
    pub const CLAIM_RETRY_QUEUED: &'static str = "RetryQueued";
    pub const CLAIM_RELEASED: &'static str = "Released";

    /// Non-terminal claim states — a Task in any of these should be reused
    /// when its Issue is re-promoted (idempotent drag-to-in_progress).
    pub fn is_nonterminal_claim(claim: &str) -> bool {
        matches!(
            claim,
            Self::CLAIM_UNCLAIMED
                | Self::CLAIM_CLAIMED
                | Self::CLAIM_RUNNING
                | Self::CLAIM_RETRY_QUEUED
        )
    }
}

// --- Span ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SpanStatus {
    Ok,
    Error(String),
    Unset,
}

impl SpanStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ok => "ok",
            Self::Error(_) => "error",
            Self::Unset => "unset",
        }
    }

    pub fn error_message(&self) -> Option<&str> {
        match self {
            Self::Error(msg) => Some(msg),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SpanType {
    Generation,  // LLM API call
    Span,        // Tool execution or logical grouping
    Event,       // Point-in-time marker (no duration)
}

impl SpanType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Generation => "generation",
            Self::Span => "span",
            Self::Event => "event",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "generation" => Self::Generation,
            "event" => Self::Event,
            _ => Self::Span,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    pub span_id: SpanId,
    pub trace_id: TraceId,
    pub parent_span_id: Option<SpanId>,
    pub session_id: SessionId,
    pub agent_name: String,
    pub operation_name: String,
    pub span_type: SpanType,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub status: SpanStatus,
    pub started_at: DateTime<Utc>,
    pub duration_ms: u64,
    pub attributes: serde_json::Value,
}

// --- Traffic ---

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrafficFilter {
    pub host: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrafficStats {
    pub total_requests: u64,
    pub total_request_bytes: u64,
    pub total_response_bytes: u64,
    pub by_host: Vec<(String, u64)>,
    pub by_status: Vec<(u16, u64)>,
}

// --- Analytics ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Analytics {
    pub total_sessions: u64,
    pub total_spans: u64,
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub by_agent: Vec<AgentAnalytics>,
    pub by_model: Vec<ModelAnalytics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAnalytics {
    pub agent_name: String,
    pub session_count: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAnalytics {
    pub model: String,
    pub span_count: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost_usd: f64,
}

// --- Guardrails ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionContext {
    pub session_id: SessionId,
    pub agent_name: String,
    pub current_cost_usd: f64,
    pub span_count: u64,
    pub recent_operations: Vec<String>,
    pub pending_command: Option<String>,
    pub pending_diff_lines: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PolicyDecision {
    Allow,
    Warn(String),
    Deny(String),
}

impl PolicyDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow | Self::Warn(_))
    }
}

// --- Sync ---

/// Summary of a single push or pull operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncResult {
    /// Number of rows exported/imported per table.
    pub tables: Vec<SyncTableResult>,
    /// Total rows across all tables.
    pub total_rows: u64,
    /// Parquet files written or downloaded.
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncTableResult {
    pub table: String,
    pub row_count: u64,
    pub parquet_path: String,
}

/// Current sync state for the `gctrl sync status` command.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub device_id: String,
    pub pending_rows: SyncPendingRows,
    pub last_push: Option<SyncEvent>,
    pub last_pull: Option<SyncEvent>,
    /// R2 reachability (DuckDB→R2 path). None if sync is disabled.
    pub r2_reachable: Option<bool>,
    /// D1 reachability (SQLite→D1 path). None if D1 not configured.
    #[serde(default)]
    pub d1_reachable: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncPendingRows {
    pub sessions: u64,
    pub spans: u64,
    pub traffic: u64,
    pub tasks: u64,
    pub context: u64,
    #[serde(default)]
    pub memory: u64,
    #[serde(default)]
    pub board_projects: u64,
    #[serde(default)]
    pub board_issues: u64,
    #[serde(default)]
    pub board_comments: u64,
    #[serde(default)]
    pub board_events: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEvent {
    pub timestamp: DateTime<Utc>,
    pub push_id: String,
    pub total_rows: u64,
}

/// A single entry in the sync manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifestEntry {
    pub push_id: String,
    pub device_id: String,
    pub timestamp: DateTime<Utc>,
    pub tables: Vec<SyncTableResult>,
}

/// The full sync manifest (local + R2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncManifest {
    pub workspace_id: String,
    pub device_id: String,
    pub pushes: Vec<SyncManifestEntry>,
    pub last_pull: Option<SyncEvent>,
    pub context_hashes: Vec<String>,
}

// --- Scores ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Score {
    pub id: String,
    pub target_type: String,  // "session", "span", "generation"
    pub target_id: String,
    pub name: String,
    pub value: f64,
    pub comment: Option<String>,
    pub source: String,  // "human", "auto", "model"
    pub scored_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

// --- Tags ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub key: String,
    pub value: String,
}

// --- Prompt Version ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptVersion {
    pub hash: String,
    pub content: String,
    pub file_path: Option<String>,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub token_count: Option<i32>,
}

// --- Alert Rule ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    pub condition_type: String,
    pub threshold: f64,
    pub action: String,
    pub enabled: bool,
}

// --- Alert Event ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertEvent {
    pub id: String,
    pub rule_id: String,
    pub session_id: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub message: String,
    pub acknowledged: bool,
}

// --- Daily Aggregate ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyAggregate {
    pub date: String,
    pub metric: String,
    pub dimension: String,
    pub value: f64,
}

// --- Board (Application) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardProject {
    pub id: String,
    pub name: String,
    pub key: String,
    pub counter: i32,
    /// GitHub repo (owner/repo) linked to this project for 2-way issue sync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    Cancelled,
}

impl IssueStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::InReview => "in_review",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "backlog" => Some(Self::Backlog),
            "todo" => Some(Self::Todo),
            "in_progress" => Some(Self::InProgress),
            "in_review" => Some(Self::InReview),
            "done" => Some(Self::Done),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Cancelled)
    }

    /// Returns the set of valid target statuses from this status.
    pub fn valid_transitions(&self) -> &'static [IssueStatus] {
        match self {
            Self::Backlog => &[Self::Todo, Self::Cancelled],
            Self::Todo => &[Self::InProgress, Self::Backlog, Self::Cancelled],
            Self::InProgress => &[Self::InReview, Self::Todo, Self::Cancelled],
            Self::InReview => &[Self::Done, Self::InProgress, Self::Cancelled],
            Self::Done => &[],
            Self::Cancelled => &[],
        }
    }

    /// Check if transitioning to `target` is valid.
    pub fn can_transition_to(&self, target: &IssueStatus) -> bool {
        self.valid_transitions().contains(target)
    }

    /// The canonical forward pipeline order.
    const FORWARD_ORDER: &'static [IssueStatus] = &[
        IssueStatus::Backlog,
        IssueStatus::Todo,
        IssueStatus::InProgress,
        IssueStatus::InReview,
        IssueStatus::Done,
    ];

    /// Returns the chain of intermediate statuses to reach `target` via forward
    /// transitions, **including** `target` itself. Returns `None` if `target` is
    /// not reachable forward from `self` (same status, backward, or terminal).
    ///
    /// Example: `Backlog.forward_path_to(InProgress)` → `Some([Todo, InProgress])`
    pub fn forward_path_to(&self, target: &IssueStatus) -> Option<Vec<IssueStatus>> {
        if *target == IssueStatus::Cancelled {
            return Some(vec![IssueStatus::Cancelled]);
        }
        let order = Self::FORWARD_ORDER;
        let from_idx = order.iter().position(|s| s == self)?;
        let to_idx = order.iter().position(|s| s == target)?;
        if to_idx <= from_idx {
            return None;
        }
        Some(order[from_idx + 1..=to_idx].to_vec())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardIssue {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: IssueStatus,
    pub priority: String,
    pub assignee_id: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_type: Option<String>,
    pub labels: Vec<String>,
    pub parent_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub created_by_id: String,
    pub created_by_name: String,
    pub created_by_type: String,
    pub blocked_by: Vec<String>,
    pub blocking: Vec<String>,
    pub session_ids: Vec<String>,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
    pub pr_numbers: Vec<u32>,
    /// SHA-256 hash of markdown body for bidirectional sync change detection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Filesystem path for markdown-based issue files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// GitHub issue number for 2-way sync. Set when synced with a GitHub issue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_issue_number: Option<u32>,
    /// GitHub issue URL for 2-way sync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BoardIssueFilter {
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub assignee_id: Option<String>,
    pub label: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardEvent {
    pub id: String,
    pub issue_id: String,
    pub event_type: String,
    pub actor_id: String,
    pub actor_name: String,
    pub actor_type: String,
    pub timestamp: DateTime<Utc>,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardComment {
    pub id: String,
    pub issue_id: String,
    pub author_id: String,
    pub author_name: String,
    pub author_type: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub session_id: Option<String>,
}

// --- Persona (Kernel Extension) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaDefinition {
    pub id: String,
    pub name: String,
    pub focus: String,
    pub prompt_prefix: String,
    pub owns: String,
    pub review_focus: String,
    pub pushes_back: String,
    pub tools: Vec<String>,
    pub key_specs: Vec<String>,
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaReviewRule {
    pub id: String,
    pub pr_type: String,
    pub persona_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRecommendation {
    pub personas: Vec<PersonaDefinition>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderedPersonaPrompt {
    pub persona_id: String,
    pub name: String,
    pub prompt: String,
}

// --- Inbox (Application) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMessage {
    pub id: String,
    pub thread_id: String,
    pub source: String,
    pub kind: String,
    pub urgency: String,
    pub title: String,
    pub body: Option<String>,
    pub context: serde_json::Value,
    pub status: String,
    pub requires_action: bool,
    pub payload: Option<serde_json::Value>,
    pub duplicate_count: u32,
    pub snoozed_until: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxThread {
    pub id: String,
    pub context_type: String,
    pub context_ref: String,
    pub title: String,
    pub project_key: Option<String>,
    pub pending_count: i64,
    pub latest_urgency: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxAction {
    pub id: String,
    pub message_id: String,
    pub thread_id: String,
    pub actor_id: String,
    pub actor_name: String,
    pub action_type: String,
    pub reason: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InboxMessageFilter {
    pub status: Option<String>,
    pub urgency: Option<String>,
    pub kind: Option<String>,
    pub project: Option<String>,
    pub thread_id: Option<String>,
    pub requires_action: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InboxActionFilter {
    pub actor_id: Option<String>,
    pub since: Option<String>,
    pub thread_id: Option<String>,
    pub limit: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_status_roundtrip() {
        let statuses = [
            SessionStatus::Active,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
        ];
        for status in &statuses {
            let s = status.as_str();
            let parsed = SessionStatus::from_str(s).unwrap();
            assert_eq!(&parsed, status);
        }
    }

    #[test]
    fn session_status_unknown_returns_none() {
        assert!(SessionStatus::from_str("unknown").is_none());
    }

    #[test]
    fn span_status_error_message() {
        let ok = SpanStatus::Ok;
        assert_eq!(ok.error_message(), None);
        assert_eq!(ok.as_str(), "ok");

        let err = SpanStatus::Error("boom".to_string());
        assert_eq!(err.error_message(), Some("boom"));
        assert_eq!(err.as_str(), "error");

        let unset = SpanStatus::Unset;
        assert_eq!(unset.error_message(), None);
    }

    #[test]
    fn policy_decision_is_allowed() {
        assert!(PolicyDecision::Allow.is_allowed());
        assert!(PolicyDecision::Warn("caution".into()).is_allowed());
        assert!(!PolicyDecision::Deny("blocked".into()).is_allowed());
    }

    #[test]
    fn traffic_filter_defaults() {
        let filter = TrafficFilter::default();
        assert!(filter.host.is_none());
        assert!(filter.since.is_none());
        assert!(filter.limit.is_none());
    }

    #[test]
    fn span_serialization_roundtrip() {
        let span = Span {
            span_id: SpanId("s1".into()),
            trace_id: TraceId("t1".into()),
            parent_span_id: None,
            session_id: SessionId("sess1".into()),
            agent_name: "claude".into(),
            operation_name: "llm.call".into(),
            span_type: SpanType::Generation,
            model: Some("claude-opus-4-6".into()),
            input_tokens: 1000,
            output_tokens: 500,
            cost_usd: 0.05,
            status: SpanStatus::Ok,
            started_at: Utc::now(),
            duration_ms: 2000,
            attributes: serde_json::json!({"tool": "bash"}),
        };
        let json = serde_json::to_string(&span).unwrap();
        let parsed: Span = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.span_id, span.span_id);
        assert_eq!(parsed.model, span.model);
    }

    #[test]
    fn persona_definition_serialization() {
        let persona = PersonaDefinition {
            id: "engineer".into(),
            name: "Principal Fullstack Engineer".into(),
            focus: "Architecture, code quality".into(),
            prompt_prefix: "You are a Principal Fullstack Engineer.".into(),
            owns: "Kernel crates, shell implementation".into(),
            review_focus: "Hexagonal boundaries, dependency direction".into(),
            pushes_back: "Adapters depend on each other".into(),
            tools: vec!["cargo build".into(), "cargo test".into()],
            key_specs: vec!["specs/architecture/".into()],
            source_hash: Some("abc123".into()),
        };
        let json = serde_json::to_string(&persona).unwrap();
        let parsed: PersonaDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "engineer");
        assert_eq!(parsed.tools.len(), 2);
    }

    #[test]
    fn inbox_message_serialization_roundtrip() {
        let msg = InboxMessage {
            id: "msg-1".into(),
            thread_id: "thr-1".into(),
            source: "guardrail".into(),
            kind: "permission_request".into(),
            urgency: "high".into(),
            title: "Force-push blocked".into(),
            body: Some("Agent wants to force-push".into()),
            context: serde_json::json!({"session_id": "sess-1", "issue_key": "BACK-42"}),
            status: "pending".into(),
            requires_action: true,
            payload: Some(serde_json::json!({"command": "git push --force"})),
            duplicate_count: 0,
            snoozed_until: None,
            expires_at: None,
            created_at: "2026-04-03T00:00:00Z".into(),
            updated_at: "2026-04-03T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: InboxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "msg-1");
        assert_eq!(parsed.kind, "permission_request");
        assert!(parsed.requires_action);
        assert_eq!(parsed.context["issue_key"], "BACK-42");
    }

    #[test]
    fn inbox_thread_serialization_roundtrip() {
        let thread = InboxThread {
            id: "thr-1".into(),
            context_type: "issue".into(),
            context_ref: "BACK-42".into(),
            title: "BACK-42: Fix auth middleware".into(),
            project_key: Some("BACK".into()),
            pending_count: 3,
            latest_urgency: "high".into(),
            created_at: "2026-04-03T00:00:00Z".into(),
            updated_at: "2026-04-03T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&thread).unwrap();
        let parsed: InboxThread = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "thr-1");
        assert_eq!(parsed.pending_count, 3);
    }

    #[test]
    fn inbox_action_serialization_roundtrip() {
        let action = InboxAction {
            id: "act-1".into(),
            message_id: "msg-1".into(),
            thread_id: "thr-1".into(),
            actor_id: "user-1".into(),
            actor_name: "Alice".into(),
            action_type: "approve".into(),
            reason: Some("Looks safe".into()),
            metadata: None,
            created_at: "2026-04-03T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        let parsed: InboxAction = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "act-1");
        assert_eq!(parsed.action_type, "approve");
        assert_eq!(parsed.reason, Some("Looks safe".into()));
    }
}
