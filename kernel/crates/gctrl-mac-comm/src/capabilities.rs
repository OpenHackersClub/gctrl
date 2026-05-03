//! Runtime capability probe.
//!
//! Tells the SPA what's supported so the inbox UI can hide affordances
//! gracefully on Linux/Windows builds and surface a clear "grant Automation"
//! prompt on macOS without click-and-hope.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    /// `"macos"`, `"linux"`, `"windows"`, or `"unknown"`.
    pub os: &'static str,
    /// Targets the runtime can attempt to focus.
    pub terminals: Vec<&'static str>,
    /// Whether `/api/comm/notify` is wired up (M1).
    pub notify: bool,
    /// Best-effort: whether the user has granted Apple Events automation.
    /// `None` on non-macOS or when probing isn't possible without triggering
    /// a TCC prompt.
    pub automation_granted: Option<bool>,
    pub captured_at: String,
}

#[cfg(target_os = "macos")]
fn os_label() -> &'static str {
    "macos"
}
#[cfg(target_os = "linux")]
fn os_label() -> &'static str {
    "linux"
}
#[cfg(target_os = "windows")]
fn os_label() -> &'static str {
    "windows"
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn os_label() -> &'static str {
    "unknown"
}

#[cfg(target_os = "macos")]
fn terminals() -> Vec<&'static str> {
    vec!["iterm2", "terminal"]
}
#[cfg(not(target_os = "macos"))]
fn terminals() -> Vec<&'static str> {
    Vec::new()
}

/// Build the capabilities snapshot. M0 returns `automation_granted: None` —
/// the UI starts polling at 10s intervals and only hides when it observes
/// `Some(true)`. Detecting the grant non-invasively requires reading TCC.db
/// which is itself privileged on Sequoia, so we defer that to M1.
pub fn capabilities() -> Capabilities {
    Capabilities {
        os: os_label(),
        terminals: terminals(),
        notify: false,
        automation_granted: None,
        captured_at: chrono::Utc::now().to_rfc3339(),
    }
}
