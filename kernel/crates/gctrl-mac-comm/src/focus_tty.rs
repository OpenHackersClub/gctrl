//! Focus the terminal pane attached to a tty.
//!
//! A process's controlling tty identifies its pane without any hook: iTerm2
//! exposes `tty` on every session and Terminal.app on every tab. The tty
//! reaches AppleScript as `item 1 of argv` after passing
//! [`crate::validate::tty`].

use crate::error::CommError;
use crate::model::FocusResponse;
use crate::validate;

#[cfg(target_os = "macos")]
const FOCUS_BY_TTY: &str = r#"
on run argv
  set target_tty to item 1 of argv
  if application "iTerm2" is running then
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is target_tty then
              select w
              tell t to select
              tell s to select
              activate
              return "iterm2"
            end if
          end repeat
        end repeat
      end repeat
    end tell
  end if
  if application "Terminal" is running then
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is target_tty then
            set selected of t to true
            set index of w to 1
            activate
            return "terminal"
          end if
        end repeat
      end repeat
    end tell
  end if
  return "not_found"
end run
"#;

/// Raise the iTerm2 session or Terminal.app tab whose tty is `tty`.
///
/// Returns `focused: true` with `reason` naming the app, or
/// `focused: false, reason: "terminal_not_found"` when no pane matches.
pub async fn focus_tty(tty: &str) -> Result<FocusResponse, CommError> {
    validate::tty(tty)?;

    #[cfg(target_os = "macos")]
    {
        let osa = crate::osascript::Osascript {
            timeout_ms: 3_000,
            target_label: "terminal",
        };
        let out = osa.run_with_args(&[FOCUS_BY_TTY], &[tty]).await?;
        if out.exit_code != 0 {
            return Err(crate::focus::classify_osascript_error(
                out.exit_code,
                &out.stderr,
                "terminal",
            ));
        }
        Ok(match out.stdout.trim() {
            "iterm2" => FocusResponse {
                focused: true,
                reason: Some("iTerm2".into()),
                deduped: false,
            },
            "terminal" => FocusResponse {
                focused: true,
                reason: Some("Terminal".into()),
                deduped: false,
            },
            _ => FocusResponse::skipped("terminal_not_found"),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(CommError::NotSupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_invalid_tty_before_osascript() {
        for bad in ["ttys003", "/dev/ttys003\"", "/dev/../etc", "/dev/ttys0; rm"] {
            let r = focus_tty(bad).await;
            assert!(
                matches!(r, Err(CommError::Validation { field: "tty", .. })),
                "accepted {bad:?}"
            );
        }
    }
}
