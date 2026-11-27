//! `focus` dispatcher.
//!
//! Single entry point — [`focus`] — accepts a validated [`FocusRequest`] and
//! routes to the per-target adapter. Adapters are platform-gated; on
//! non-macOS, every adapter is a no-op stub and `focus` returns
//! [`CommError::NotSupported`]. The HTTP layer turns that into a 501.
//!
//! Validation happens BEFORE this function runs (see `validate.rs` and the
//! HTTP handler). This module assumes inputs are already safe to pass to
//! `osascript`.

#[cfg(target_os = "macos")]
mod iterm2;
#[cfg(target_os = "macos")]
mod terminal;

use crate::error::CommError;
use crate::model::{FocusRequest, FocusResponse};
// TerminalApp is only referenced inside the macOS-gated dispatch arm. On
// Linux/Windows the dispatcher returns NotSupported without inspecting
// the target, so importing the type unconditionally would trip
// `unused_imports` under CI's `-D warnings`.
#[cfg(target_os = "macos")]
use crate::model::TerminalApp;

/// Map a failed `osascript` run to a typed error.
#[cfg(target_os = "macos")]
pub(crate) fn classify_osascript_error(
    exit_code: i32,
    stderr: &str,
    target: &'static str,
) -> CommError {
    // -1743: Apple Events authorization denied. The error code lands in
    // stderr from osascript; checking stderr is reliable across macOS
    // versions (the exit code is always non-zero on these conditions).
    if stderr.contains("-1743") || stderr.contains("not allowed assistive access") {
        return CommError::AutomationDenied { target };
    }
    // -600: application is not running (NSAppleScriptError "application isn't running").
    if stderr.contains("-600") || stderr.contains("isn't running") {
        return CommError::TargetNotRunning { target };
    }
    CommError::OsascriptFailed {
        exit_code,
        stderr: stderr.to_string(),
    }
}

/// Bring the originating terminal session to the foreground.
///
/// `req` MUST already be validated by [`crate::validate::focus_request`].
pub async fn focus(req: &FocusRequest) -> Result<FocusResponse, CommError> {
    if req.origin_remote {
        return Ok(FocusResponse::skipped("remote_session"));
    }

    #[cfg(target_os = "macos")]
    {
        match req.target {
            TerminalApp::Iterm2 => iterm2::focus(req).await,
            TerminalApp::Terminal => terminal::focus(req).await,
            TerminalApp::Ghostty | TerminalApp::Vscode | TerminalApp::Warp => {
                Err(CommError::UnknownTarget(format!(
                    "{:?} adapter not implemented in M0",
                    req.target
                )))
            }
            TerminalApp::Unknown => Err(CommError::UnknownTarget("unknown".into())),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = req;
        Err(CommError::NotSupported)
    }
}
