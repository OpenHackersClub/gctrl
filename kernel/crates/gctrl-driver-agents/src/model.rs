//! Wire types for `/api/agents/*`. Field meanings: spec § Model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    ClaudeCode,
    Codex,
    Hermes,
    Pi,
}

impl Harness {
    pub const ALL: [Harness; 4] = [Harness::ClaudeCode, Harness::Codex, Harness::Hermes, Harness::Pi];

    /// Prefix of a run id: `claude:<id>`, `codex:<id>`, `hermes:<id>`, `pi:<id>`.
    pub const fn prefix(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude",
            Harness::Codex => "codex",
            Harness::Hermes => "hermes",
            Harness::Pi => "pi",
        }
    }

    /// The fixed resume command for `native_id` (spec § Open and resume).
    pub fn resume_argv(self, native_id: &str) -> Vec<String> {
        let argv: Vec<&str> = match self {
            Harness::ClaudeCode => vec!["claude", "--resume", native_id],
            Harness::Codex => vec!["codex", "resume", "-c", "tui.resume_cwd=current", native_id],
            Harness::Hermes => vec!["hermes", "--resume", native_id],
            Harness::Pi => vec!["pi", "--session", native_id],
        };
        argv.into_iter().map(str::to_string).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Running,
    Idle,
    Resumable,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStatus {
    Busy,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveInfo {
    pub pid: u32,
    pub tty: Option<String>,
    pub status: LiveStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrLink {
    pub number: u64,
    pub url: String,
    pub repository: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: String,
    pub harness: Harness,
    pub native_id: String,
    pub title: String,
    pub name: Option<String>,
    pub project_key: String,
    pub cwd: String,
    pub cwd_exists: bool,
    pub worktree: Option<String>,
    pub git_branch: Option<String>,
    pub last_prompt: Option<String>,
    pub pr: Option<PrLink>,
    pub cost_usd: Option<f64>,
    pub tokens: Option<i64>,
    pub model: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub headless: bool,
    pub archived: bool,
    pub stale: bool,
    pub live: Option<LiveInfo>,
    pub state: RunState,
    pub resume_command: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Hidden {
    pub headless: usize,
    pub stale: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListResponse {
    pub generated_at: String,
    pub runs: Vec<AgentRun>,
    pub hidden: Hidden,
    /// Run ids waiting for their turn to end before a gather moves them.
    #[serde(default)]
    pub gather_queue: Vec<String>,
}

/// One run's outcome in a gather (spec § Gather into a Space).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatherItem {
    pub id: String,
    /// `resumed`, `moved`, `queued` or `skipped`.
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatherResponse {
    /// iTerm2 window id that holds the gathered tabs; None when nothing opened.
    pub window_id: Option<i64>,
    pub items: Vec<GatherItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenResponse {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}
