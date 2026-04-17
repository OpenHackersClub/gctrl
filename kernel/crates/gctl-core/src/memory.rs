//! Memory subsystem domain types.
//!
//! Memory is long-lived knowledge that follows the user across sessions and devices.
//! It is distinct from `context` (larger markdown documents) and `sessions` (ephemeral).
//!
//! The taxonomy mirrors the auto-memory system used by Claude Code:
//!   - User        — who the user is, how they collaborate
//!   - Feedback    — rules/preferences from explicit correction or confirmation
//!   - Project     — facts/decisions about ongoing work, stakeholders, deadlines
//!   - Reference   — pointers to external systems (Linear, Grafana, Slack)
//!
//! Every row carries the D1 sync contract (`device_id`, `updated_at`, `synced`) so
//! it can round-trip to Cloudflare D1 via `gctl-sync`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MemoryEntryId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    /// Who the user is, their role, knowledge, preferences.
    User,
    /// Rules/preferences derived from explicit correction or confirmation.
    Feedback,
    /// Facts about ongoing work: decisions, stakeholders, deadlines.
    Project,
    /// Pointers to external resources (Linear project, Grafana dashboard, etc).
    Reference,
}

impl MemoryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Feedback => "feedback",
            Self::Project => "project",
            Self::Reference => "reference",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "feedback" => Some(Self::Feedback),
            "project" => Some(Self::Project),
            "reference" => Some(Self::Reference),
            _ => None,
        }
    }
}

/// A single memory entry. Short-form knowledge stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: MemoryEntryId,
    #[serde(rename = "type")]
    pub memory_type: MemoryType,
    /// Short stable name, e.g. "user_role", "feedback_no_bun".
    pub name: String,
    /// One-line description used to decide relevance at recall time.
    pub description: String,
    /// The memory body (rule/fact/pointer). Plain text; small (KB scale).
    pub body: String,
    pub tags: Vec<String>,
    /// Device that last wrote this row — required by the D1 sync protocol
    /// (pulls exclude rows with `device_id == self.device_id`).
    pub device_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub synced: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryFilter {
    #[serde(rename = "type")]
    pub memory_type: Option<MemoryType>,
    pub tag: Option<String>,
    pub search: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryStats {
    pub total_entries: u64,
    pub by_type: Vec<(String, u64)>,
    pub unsynced: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_type_roundtrip() {
        for ty in [
            MemoryType::User,
            MemoryType::Feedback,
            MemoryType::Project,
            MemoryType::Reference,
        ] {
            assert_eq!(MemoryType::from_str(ty.as_str()), Some(ty));
        }
    }

    #[test]
    fn memory_type_unknown_returns_none() {
        assert!(MemoryType::from_str("episodic").is_none());
    }

    #[test]
    fn memory_entry_serialization() {
        let entry = MemoryEntry {
            id: MemoryEntryId("mem-1".into()),
            memory_type: MemoryType::Feedback,
            name: "no_bun".into(),
            description: "use pnpm not bun".into(),
            body: "Always use pnpm; user explicitly rejected bun.".into(),
            tags: vec!["tooling".into()],
            device_id: "dev-a".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            synced: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let parsed: MemoryEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, entry.id);
        assert_eq!(parsed.memory_type, MemoryType::Feedback);
        assert_eq!(parsed.name, "no_bun");
    }

    #[test]
    fn memory_type_serializes_snake_case() {
        let json = serde_json::to_string(&MemoryType::Reference).unwrap();
        assert_eq!(json, "\"reference\"");
    }
}
