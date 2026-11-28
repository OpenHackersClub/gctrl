//! Launch a command in a new iTerm2 tab.
//!
//! mac-comm owns the shell string. Callers pass a working directory and an
//! argv; [`shell_command`] validates both and renders
//! `cd '<cwd>'`, activates direnv, then invokes the argv. The cwd validator excludes `'`, so single quotes
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
    Ok(format!(
        "cd '{}' && {{ if command -v direnv >/dev/null 2>&1; then \
         _gctrl_direnv=$(direnv export bash) && eval \"$_gctrl_direnv\" && unset _gctrl_direnv; \
         fi; }} && {}",
        req.cwd,
        req.argv.join(" ")
    ))
}

#[cfg(any(target_os = "macos", test))]
const ITERM2_LAUNCH: &str = r#"
on run argv
  set cmd to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
      set target_session to current session of tab 1 of w
    else
      set w to current window
      tell w to set created_tab to (create tab with default profile)
      set target_session to current session of created_tab
    end if
    tell target_session to write text cmd
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

/// A new iTerm2 window and the commands typed into its tabs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowResponse {
    pub window_id: i64,
    pub commands: Vec<String>,
}

#[cfg(any(target_os = "macos", test))]
const ITERM2_WINDOW: &str = r#"
on run argv
  tell application "iTerm2"
    set w to (create window with default profile)
    set is_first to true
    repeat with cmd in argv
      if is_first then
        set is_first to false
        set target_session to current session of tab 1 of w
      else
        tell w to set created_tab to (create tab with default profile)
        set target_session to current session of created_tab
      end if
      tell target_session to write text (cmd as text)
    end repeat
    activate
    return (id of w) as text
  end tell
end run
"#;

#[cfg(any(target_os = "macos", test))]
const ITERM2_TAB_IN_WINDOW: &str = r#"
on run argv
  set wid to (item 1 of argv) as integer
  set cmd to item 2 of argv
  set mode to item 3 of argv
  tell application "iTerm2"
    set w to window id wid
    if mode is "new" then
      tell w to set created_tab to (create tab with default profile)
      set target_session to current session of created_tab
    else
      set target_session to current session of tab 1 of w
    end if
    tell target_session to write text cmd
  end tell
  return "ok"
end run
"#;

/// Open one iTerm2 window on the active Space, with one tab per request.
/// The window opens with a plain shell when `reqs` is empty.
pub async fn open_window(reqs: &[LaunchRequest]) -> Result<WindowResponse, CommError> {
    let commands = reqs.iter().map(shell_command).collect::<Result<Vec<_>, _>>()?;

    #[cfg(target_os = "macos")]
    {
        let osa = crate::osascript::Osascript {
            timeout_ms: 10_000 + 2_000 * commands.len() as u64,
            target_label: "iTerm2",
        };
        let args: Vec<&str> = commands.iter().map(String::as_str).collect();
        let out = osa.run_with_args(&[ITERM2_WINDOW], &args).await?;
        if out.exit_code == 0 {
            if let Ok(window_id) = out.stdout.trim().parse::<i64>() {
                return Ok(WindowResponse { window_id, commands });
            }
        }
        Err(crate::focus::classify_osascript_error(out.exit_code, &out.stderr, "iTerm2"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = commands;
        Err(CommError::NotSupported)
    }
}

/// Type the resume command into iTerm2 window `window_id`: into a new tab,
/// or into its first tab when `reuse_current` (the shell a fresh window opens
/// with). Each call writes to its captured session, independent of tab selection.
pub async fn open_tab_in_window(
    window_id: i64,
    req: &LaunchRequest,
    reuse_current: bool,
) -> Result<LaunchResponse, CommError> {
    let command = shell_command(req)?;

    #[cfg(target_os = "macos")]
    {
        let osa = crate::osascript::Osascript {
            timeout_ms: 10_000,
            target_label: "iTerm2",
        };
        let wid = window_id.to_string();
        let mode = if reuse_current { "reuse" } else { "new" };
        let out = osa
            .run_with_args(&[ITERM2_TAB_IN_WINDOW], &[&wid, &command, mode])
            .await?;
        if out.exit_code == 0 && out.stdout.trim() == "ok" {
            return Ok(LaunchResponse { launched: true, command });
        }
        Err(crate::focus::classify_osascript_error(out.exit_code, &out.stderr, "iTerm2"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window_id, command, reuse_current);
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
        assert!(cmd.starts_with("cd '/Users/me/wt/acme/api/fix (2)' && "));
        assert!(cmd.ends_with(" && claude --resume 26e3373e-8358-416b-83f3-355a59325193"));
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
    fn activates_project_environment_before_bash_prompt_hook() {
        let command = shell_command(&req("/tmp", &["fake_harness"])).unwrap();
        let script = format!(
            "PROMPT_COMMAND='export CLAUDE_CONFIG_DIR=project-account'; \
             direnv() {{ printf '%s\\n' 'export CLAUDE_CONFIG_DIR=project-account'; }}; \
             fake_harness() {{ printf '%s' \"$CLAUDE_CONFIG_DIR\"; }}; {command}"
        );
        let output = std::process::Command::new("bash")
            .args(["--noprofile", "--norc", "-c", &script])
            .env("CLAUDE_CONFIG_DIR", "previous-account")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "project-account");
    }

    #[test]
    fn failed_project_environment_does_not_start_harness() {
        let command = shell_command(&req("/tmp", &["fake_harness"])).unwrap();
        let script = format!(
            "direnv() {{ return 1; }}; fake_harness() {{ printf started; }}; {command}"
        );
        let output = std::process::Command::new("bash")
            .args(["--noprofile", "--norc", "-c", &script])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn scripts_target_the_created_session() {
        for script in [ITERM2_LAUNCH, ITERM2_WINDOW, ITERM2_TAB_IN_WINDOW] {
            assert!(!script.contains("tell current session of w to write"));
            assert!(script.contains("tell target_session to write text"));
        }
        assert!(ITERM2_TAB_IN_WINDOW.contains("current session of tab 1 of w"));
    }

    #[tokio::test]
    async fn window_ops_validate_before_osascript() {
        let bad = req("/tmp", &["claude", "a;b"]);
        assert!(matches!(open_window(std::slice::from_ref(&bad)).await, Err(CommError::Validation { .. })));
        assert!(matches!(
            open_tab_in_window(1, &bad, false).await,
            Err(CommError::Validation { .. })
        ));
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
