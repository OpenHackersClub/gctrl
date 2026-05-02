//! iTerm2 focus adapter.
//!
//! AppleScript surface notes (corrected during spec review):
//! - The application bundle name in AppleScript context is `"iTerm2"`, not
//!   `"iTerm"`. Pre-3.x installations registered as `iTerm` but every modern
//!   release is `iTerm2`.
//! - There is no flat `select session id "<sid>"` form. Sessions are reached
//!   via `windows → tabs → sessions` traversal, addressed by `unique ID`.
//!
//! The handler script below is invoked as ONE `-e` argv entry; the
//! handler-call expression is a SECOND `-e`. The session ID is interpolated
//! into the AppleScript expression but only after passing the iTerm2 UUID
//! regex (`[wtp][0-9]+:[A-Fa-f0-9-]{36}`), which excludes every character
//! AppleScript would treat as syntactically meaningful.

use crate::error::CommError;
use crate::model::{FocusRequest, FocusResponse};
use crate::osascript::Osascript;

const HANDLER_SCRIPT: &str = r#"
on focus_iterm2_session(target_id)
  tell application "iTerm2"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique ID of s is target_id then
            select s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end focus_iterm2_session
"#;

pub async fn focus(req: &FocusRequest) -> Result<FocusResponse, CommError> {
    let sid = req
        .session_id
        .as_deref()
        .ok_or(CommError::Validation {
            field: "session_id",
            pattern: "required for target=iterm2",
        })?;

    let osa = Osascript {
        timeout_ms: 2_000,
        target_label: "iTerm2",
    };
    let call = format!(r#"focus_iterm2_session("{}")"#, sid);
    let out = osa.run(&[HANDLER_SCRIPT, &call]).await?;

    if out.exit_code == 0 {
        return match out.stdout.trim() {
            "ok" => Ok(FocusResponse::ok()),
            "not_found" => Err(CommError::SessionNotFound {
                target: "iTerm2",
                session_id: sid.to_string(),
            }),
            other => Err(CommError::OsascriptFailed {
                exit_code: 0,
                stderr: format!("unexpected handler output: {}", other),
            }),
        };
    }

    classify_error(out.exit_code, &out.stderr, "iTerm2")
}

fn classify_error(
    exit_code: i32,
    stderr: &str,
    target: &'static str,
) -> Result<FocusResponse, CommError> {
    // -1743: Apple Events authorization denied. The error code lands in
    // stderr from osascript; checking stderr is reliable across macOS
    // versions (the exit code is always non-zero on these conditions).
    if stderr.contains("-1743") || stderr.contains("not allowed assistive access") {
        return Err(CommError::AutomationDenied { target });
    }
    // -600: application is not running (NSAppleScriptError "application isn't running").
    if stderr.contains("-600") || stderr.contains("isn't running") {
        return Err(CommError::TargetNotRunning { target });
    }
    Err(CommError::OsascriptFailed {
        exit_code,
        stderr: stderr.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_automation_denied() {
        let r = classify_error(1, "execution error: not allowed assistive access (-1743)", "iTerm2");
        assert!(matches!(r, Err(CommError::AutomationDenied { target: "iTerm2" })));
    }

    #[test]
    fn classify_not_running() {
        let r = classify_error(1, "execution error: isn't running (-600)", "iTerm2");
        assert!(matches!(r, Err(CommError::TargetNotRunning { target: "iTerm2" })));
    }

    #[test]
    fn classify_other_error() {
        let r = classify_error(1, "some other failure", "iTerm2");
        assert!(matches!(r, Err(CommError::OsascriptFailed { .. })));
    }
}
