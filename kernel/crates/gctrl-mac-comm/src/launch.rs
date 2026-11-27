//! Launch a command in a new iTerm2 tab.
//!
//! mac-comm owns the shell string. Callers pass a working directory and an
//! argv; [`shell_command`] validates both and renders
//! `cd '<cwd>' && <argv…>`. The cwd validator excludes `'`, so single quotes
//! make every allowed cwd character literal. Each argv token matches a strict
//! allowlist with no shell metacharacters. The rendered command reaches
//! AppleScript as `item 1 of argv` and is never spliced into script source.

use crate::error::CommError;
use crate::validate;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchRequest {
    pub cwd: String,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchResponse {
    pub launched: bool,
    pub command: String,
}

fn re_arg() -> &'static Regex {
    static CACHED: OnceLock<Regex> = OnceLock::new();
    CACHED.get_or_init(|| Regex::new(r"^[A-Za-z0-9._=:/@+-]{1,128}$").expect("valid regex"))
}

/// Render the validated shell command for `req`.
pub fn shell_command(req: &LaunchRequest) -> Result<String, CommError> {
    validate::cwd(&req.cwd)?;
    if req.argv.is_empty() || req.argv.len() > 16 {
        return Err(CommError::Validation {
            field: "argv",
            pattern: "1..=16 tokens",
        });
    }
    for a in &req.argv {
        if !re_arg().is_match(a) {
            return Err(CommError::Validation {
                field: "argv",
                pattern: r"[A-Za-z0-9._=:/@+-]{1,128}",
            });
        }
    }
    Ok(format!("cd '{}' && {}", req.cwd, req.argv.join(" ")))
}

#[cfg(target_os = "macos")]
const ITERM2_LAUNCH: &str = r#"
on run argv
  set cmd to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text cmd
  end tell
  return "ok"
end run
"#;

/// Open a new iTerm2 tab (or window when none is open) and type the
/// rendered command into its shell.
pub async fn launch(req: &LaunchRequest) -> Result<LaunchResponse, CommError> {
    let command = shell_command(req)?;

    #[cfg(target_os = "macos")]
    {
        let osa = crate::osascript::Osascript {
            // Cold-starting iTerm2 takes longer than raising a session.
            timeout_ms: 10_000,
            target_label: "iTerm2",
        };
        let out = osa.run_with_args(&[ITERM2_LAUNCH], &[&command]).await?;
        if out.exit_code == 0 && out.stdout.trim() == "ok" {
            return Ok(LaunchResponse {
                launched: true,
                command,
            });
        }
        Err(crate::focus::classify_osascript_error(
            out.exit_code,
            &out.stderr,
            "iTerm2",
        ))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = command;
        Err(CommError::NotSupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(cwd: &str, argv: &[&str]) -> LaunchRequest {
        LaunchRequest {
            cwd: cwd.into(),
            argv: argv.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn renders_claude_resume() {
        let cmd = shell_command(&req(
            "/Users/me/wt/acme/api/fix (2)",
            &["claude", "--resume", "26e3373e-8358-416b-83f3-355a59325193"],
        ))
        .unwrap();
        assert_eq!(
            cmd,
            "cd '/Users/me/wt/acme/api/fix (2)' && claude --resume 26e3373e-8358-416b-83f3-355a59325193"
        );
    }

    #[test]
    fn renders_codex_resume_with_config_override() {
        let cmd = shell_command(&req(
            "/Users/me/src",
            &["codex", "resume", "-c", "tui.resume_cwd=current", "01a04c15-4628-7913-bd1d-21ed78284c55"],
        ))
        .unwrap();
        assert!(cmd.ends_with("codex resume -c tui.resume_cwd=current 01a04c15-4628-7913-bd1d-21ed78284c55"));
    }

    #[test]
    fn rejects_quote_in_cwd() {
        assert!(shell_command(&req("/tmp/it's", &["claude"])).is_err());
    }

    #[test]
    fn rejects_relative_cwd() {
        assert!(shell_command(&req("tmp", &["claude"])).is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_in_argv() {
        for bad in ["a;b", "$(x)", "`x`", "a b", "a|b", "a>b", "'", "\""] {
            assert!(
                shell_command(&req("/tmp", &["claude", bad])).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_empty_argv() {
        assert!(shell_command(&req("/tmp", &[])).is_err());
    }
}
