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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}
