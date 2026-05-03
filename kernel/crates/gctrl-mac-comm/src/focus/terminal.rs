//! Apple Terminal.app focus adapter (best-effort).
//!
//! Identity for Terminal.app is the `(window-index, tab-index)` pair.
//! `$TERM_SESSION_ID` is undocumented and unstable across macOS versions, so
//! the capture hook stores indices instead and the adapter looks up by
//! position. AppleScript verb is `set selected of tab N of window M to true`.

use crate::error::CommError;
use crate::model::{FocusRequest, FocusResponse};
use crate::osascript::Osascript;

const HANDLER_SCRIPT: &str = r#"
on focus_terminal_tab(window_idx, tab_idx)
  tell application "Terminal"
    activate
    try
      set selected of tab tab_idx of window window_idx to true
      return "ok"
    on error errMsg number errNum
      if errNum is -1719 then
        return "not_found"
      else
        error errMsg number errNum
      end if
    end try
  end tell
end focus_terminal_tab
"#;

pub async fn focus(req: &FocusRequest) -> Result<FocusResponse, CommError> {
    let window = req
        .window_id
        .as_deref()
        .ok_or(CommError::Validation {
            field: "window_id",
            pattern: "required for target=terminal",
        })?;
    let tab = req.tab_id.as_deref().ok_or(CommError::Validation {
        field: "tab_id",
        pattern: "required for target=terminal",
    })?;

    let osa = Osascript {
        timeout_ms: 2_000,
        target_label: "Terminal",
    };
    let call = format!("focus_terminal_tab({}, {})", window, tab);
    let out = osa.run(&[HANDLER_SCRIPT, &call]).await?;

    if out.exit_code == 0 {
        return match out.stdout.trim() {
            "ok" => Ok(FocusResponse::ok()),
            "not_found" => Err(CommError::SessionNotFound {
                target: "Terminal",
                session_id: format!("window={} tab={}", window, tab),
            }),
            other => Err(CommError::OsascriptFailed {
                exit_code: 0,
                stderr: format!("unexpected handler output: {}", other),
            }),
        };
    }

    if out.stderr.contains("-1743") || out.stderr.contains("not allowed assistive access") {
        return Err(CommError::AutomationDenied { target: "Terminal" });
    }
    if out.stderr.contains("-600") || out.stderr.contains("isn't running") {
        return Err(CommError::TargetNotRunning { target: "Terminal" });
    }

    Err(CommError::OsascriptFailed {
        exit_code: out.exit_code,
        stderr: out.stderr,
    })
}
