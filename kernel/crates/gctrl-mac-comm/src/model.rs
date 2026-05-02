use serde::{Deserialize, Serialize};

/// The terminal application discriminator. Matches `context.terminal.app` in
/// inbox messages. `unknown` is the explicit "we couldn't identify" value —
/// the inbox UI hides the Focus button for unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalApp {
    Iterm2,
    Terminal,
    Ghostty,
    Vscode,
    Warp,
    Unknown,
}

impl TerminalApp {
    pub const fn label(self) -> &'static str {
        match self {
            TerminalApp::Iterm2 => "iTerm2",
            TerminalApp::Terminal => "Terminal",
            TerminalApp::Ghostty => "Ghostty",
            TerminalApp::Vscode => "VS Code",
            TerminalApp::Warp => "Warp",
            TerminalApp::Unknown => "unknown",
        }
    }

    pub const fn bundle_id(self) -> &'static str {
        match self {
            TerminalApp::Iterm2 => "com.googlecode.iterm2",
            TerminalApp::Terminal => "com.apple.Terminal",
            TerminalApp::Ghostty => "com.mitchellh.ghostty",
            TerminalApp::Vscode => "com.microsoft.VSCode",
            TerminalApp::Warp => "dev.warp.Warp-Stable",
            TerminalApp::Unknown => "",
        }
    }
}

/// Captured terminal context — the contents of `inbox_messages.context.terminal`.
///
/// Every string field is validated by [`crate::validate`] before reaching an
/// `osascript` adapter. The validators live next to the type definitions so
/// schema and policy stay in sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalContext {
    pub app: TerminalApp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ppid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term_program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term_program_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

/// Body of `POST /api/comm/focus`. The HTTP handler validates each field via
/// [`crate::validate`] before calling [`crate::focus`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusRequest {
    pub target: TerminalApp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Set by the kernel HTTP layer when the request arrived from a non-loopback
    /// connection. Triggers `reason: "remote_session"` short-circuit instead of
    /// invoking osascript. Spoofing in the request body is meaningless because
    /// the field is overwritten at intake.
    #[serde(default, skip_serializing)]
    pub origin_remote: bool,
}

/// Response shape for `POST /api/comm/focus`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusResponse {
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deduped: bool,
}

impl FocusResponse {
    pub fn ok() -> Self {
        Self {
            focused: true,
            reason: None,
            deduped: false,
        }
    }

    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            focused: false,
            reason: Some(reason.into()),
            deduped: false,
        }
    }

    pub fn deduped() -> Self {
        Self {
            focused: true,
            reason: None,
            deduped: true,
        }
    }
}
