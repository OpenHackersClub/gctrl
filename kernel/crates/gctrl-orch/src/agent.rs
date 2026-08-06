//! Agent subprocess spawn mechanics.
//!
//! ## Environment isolation
//!
//! A dispatched agent runs with a **cleared** environment, repopulated only
//! with [`BASE_ENV_KEYS`] plus the operator-declared passthrough list
//! (`OrchConfig::env_passthrough`). Inheriting the daemon's environment is
//! not safe by default: `gctrld` is normally started from a LaunchAgent whose
//! environment carries live credentials (`TELEGRAM_BOT_TOKEN`,
//! `GCTRL_R2_SECRET_ACCESS_KEY`, …). An agent has no reason to hold those,
//! and whatever it writes to stdout is posted back to the issue as a comment.
//!
//! This is the same contract `gctrl-scheduler::exec` enforces for
//! `target_kind: exec` schedules — see that module's header for the identical
//! reasoning applied to scheduled commands.
//!
//! `SSH_AUTH_SOCK` is deliberately absent from the baseline: forwarding the
//! agent socket lets the child authenticate as the user over SSH. An operator
//! who wants agents pushing over SSH opts in by naming it explicitly.

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

/// Environment variables always forwarded to a dispatched agent.
///
/// Process baseline only — the locale, path, and identity variables nearly
/// every runtime needs to start at all (program lookup reads `PATH`, git and
/// most CLIs need `HOME`, temp files need `TMPDIR`). None carry credentials.
///
/// Everything else, including the agent's own model credential, comes from
/// the operator's passthrough list.
pub const BASE_ENV_KEYS: &[&str] = &[
    "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "TZ",
    "USER",
];

/// Select the variables a child may see: [`BASE_ENV_KEYS`] plus `passthrough`.
///
/// Split out from [`resolve_env`] so the filtering rule is testable without
/// mutating the process environment, which is global and racy under a
/// parallel test runner.
pub fn select_env<I>(vars: I, passthrough: &[String]) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let allowed: HashSet<&str> = BASE_ENV_KEYS
        .iter()
        .copied()
        .chain(passthrough.iter().map(String::as_str))
        .collect();
    vars.into_iter()
        .filter(|(k, _)| allowed.contains(k.as_str()))
        .collect()
}

/// [`select_env`] applied to the daemon's own environment.
pub fn resolve_env(passthrough: &[String]) -> Vec<(String, String)> {
    select_env(std::env::vars(), passthrough)
}

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("spawn failed: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("agent exited with code {0}")]
    NonZero(i32),
    #[error("agent killed by signal")]
    Signal,
    #[error("timed out after {0:?}")]
    Timeout(Duration),
}

#[derive(Debug)]
pub struct AgentRun {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Start the subprocess and write the prompt to stdin. Returns the live
/// child. Errors here are pre-`agentLaunched` in the Lean spec's language —
/// the worker should transition `Claimed → Released` (dispatchFailed), not
/// through `Running`.
///
/// `env` is the child's **complete** environment — see the module header.
/// A caller that omits `PATH` from it will not be able to spawn a program
/// named relatively, since Unix resolves a relative program against the
/// child's `PATH`, not the parent's.
pub async fn spawn_agent(
    cmd: &[String],
    working_dir: &Path,
    prompt: &str,
    env: &[(String, String)],
) -> Result<Child, SpawnError> {
    let (program, args) = cmd
        .split_first()
        .ok_or_else(|| SpawnError::Spawn(std::io::Error::other("empty agent command")))?;

    let mut child = Command::new(program)
        .args(args)
        .current_dir(working_dir)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        // A child that exits before reading its input (e.g. `sh -c "exit 1"`)
        // closes the pipe out from under us. That's not a spawn failure —
        // the process is already launched and its exit code should drive the
        // retry decision. Swallow BrokenPipe here so `await_agent` sees the
        // real exit status instead of us reporting dispatchFailed.
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                return Err(SpawnError::Spawn(e));
            }
        }
        if let Err(e) = stdin.shutdown().await {
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                return Err(SpawnError::Spawn(e));
            }
        }
    }

    Ok(child)
}

/// Wait for an already-spawned child. Errors here happen after
/// `agentLaunched`, so the worker should transition `Running → RetryQueued`
/// (agentExitAbnormal).
pub async fn await_agent(child: Child, timeout: Duration) -> Result<AgentRun, SpawnError> {
    let result = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r?,
        Err(_) => {
            // tokio::process kills the child when dropped on timeout.
            return Err(SpawnError::Timeout(timeout));
        }
    };

    let exit = result.status.code().ok_or(SpawnError::Signal)?;
    if exit != 0 {
        return Err(SpawnError::NonZero(exit));
    }
    Ok(AgentRun {
        stdout: String::from_utf8_lossy(&result.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&result.stderr).into_owned(),
        exit_code: exit,
    })
}

/// Convenience: spawn then await in one call. Error phase is not
/// distinguished — the worker uses `spawn_agent` + `await_agent` directly
/// so it can route `SpawnError::Spawn` to `dispatchFailed`.
#[cfg(test)]
pub async fn run_agent(
    cmd: &[String],
    working_dir: &Path,
    prompt: &str,
    timeout: Duration,
    env: &[(String, String)],
) -> Result<AgentRun, SpawnError> {
    let child = spawn_agent(cmd, working_dir, prompt, env).await?;
    await_agent(child, timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Baseline env for spawn tests. `cat` / `sh` are named relatively, so the
    /// child needs a `PATH` to resolve them — which is exactly what
    /// `BASE_ENV_KEYS` guarantees in production.
    fn base_env() -> Vec<(String, String)> {
        resolve_env(&[])
    }

    #[tokio::test]
    async fn echo_succeeds_and_captures_stdout() {
        // `cat` echoes the prompt from stdin back to stdout — a stand-in
        // agent that lets CI run without claude on the PATH.
        let run = run_agent(
            &["cat".into()],
            Path::new("."),
            "hello from worker",
            Duration::from_secs(5),
            &base_env(),
        )
        .await
        .unwrap();
        assert_eq!(run.exit_code, 0);
        assert!(run.stdout.contains("hello from worker"));
    }

    #[tokio::test]
    async fn nonzero_exit_is_reported() {
        let err = run_agent(
            &["sh".into(), "-c".into(), "exit 7".into()],
            Path::new("."),
            "",
            Duration::from_secs(5),
            &base_env(),
        )
        .await
        .unwrap_err();
        match err {
            SpawnError::NonZero(code) => assert_eq!(code, 7),
            e => panic!("unexpected: {e:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_is_reported() {
        let err = run_agent(
            &["sh".into(), "-c".into(), "sleep 5".into()],
            Path::new("."),
            "",
            Duration::from_millis(100),
            &base_env(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SpawnError::Timeout(_)));
    }

    #[tokio::test]
    async fn child_that_exits_before_reading_stdin_reports_nonzero_not_spawn() {
        // Regression: a child that closes stdin before we finish writing
        // (sh -c "exit 1" on a fast Linux runner) used to bubble up as
        // SpawnError::Spawn(BrokenPipe), which the Worker routes to
        // dispatchFailed → Released instead of Running → RetryQueued.
        let prompt: String = "x".repeat(256 * 1024);
        let err = run_agent(
            &["sh".into(), "-c".into(), "exit 1".into()],
            Path::new("."),
            &prompt,
            Duration::from_secs(5),
            &base_env(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, SpawnError::NonZero(1)),
            "expected NonZero(1), got {err:?}"
        );
    }

    #[tokio::test]
    async fn missing_binary_is_reported() {
        let err = run_agent(
            &["this-binary-does-not-exist-12345".into()],
            Path::new("."),
            "",
            Duration::from_secs(5),
            &base_env(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SpawnError::Spawn(_)));
    }

    #[test]
    fn select_env_keeps_baseline_and_passthrough_only() {
        let vars = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("TELEGRAM_BOT_TOKEN".to_string(), "leak".to_string()),
            ("GCTRL_R2_SECRET_ACCESS_KEY".to_string(), "leak".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "wanted".to_string()),
        ];
        let out = select_env(vars, &["ANTHROPIC_API_KEY".to_string()]);
        let keys: HashSet<&str> = out.iter().map(|(k, _)| k.as_str()).collect();

        assert!(keys.contains("PATH"), "baseline var dropped");
        assert!(keys.contains("ANTHROPIC_API_KEY"), "passthrough var dropped");
        assert!(!keys.contains("TELEGRAM_BOT_TOKEN"));
        assert!(!keys.contains("GCTRL_R2_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn baseline_forwards_no_credential_bearing_vars() {
        // The agent socket is the one plausible-looking omission: forwarding
        // it would let a dispatched agent authenticate as the user over SSH.
        assert!(!BASE_ENV_KEYS.contains(&"SSH_AUTH_SOCK"));
        for key in BASE_ENV_KEYS {
            let k = key.to_ascii_uppercase();
            assert!(
                !["TOKEN", "SECRET", "KEY", "PASSWORD", "WEBHOOK"]
                    .iter()
                    .any(|needle| k.contains(needle)),
                "credential-shaped name in the always-forward baseline: {key}"
            );
        }
    }

    #[tokio::test]
    async fn child_env_is_exactly_what_was_supplied() {
        // The parent is far richer than the two pairs below; `/usr/bin/env`
        // prints the child's whole environment, so an inherited variable
        // would show up here. Absolute path because a cleared env has no
        // `PATH` to resolve a relative program against.
        assert!(
            std::env::var_os("PATH").is_some(),
            "parent must have PATH or this proves nothing"
        );
        let env = vec![
            ("MARKER".to_string(), "ok".to_string()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ];
        let run = run_agent(
            &["/usr/bin/env".into()],
            Path::new("."),
            "",
            Duration::from_secs(5),
            &env,
        )
        .await
        .unwrap();

        let mut keys: Vec<&str> = run
            .stdout
            .lines()
            .filter_map(|l| l.split('=').next())
            .filter(|k| !k.is_empty())
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["MARKER", "PATH"], "child env: {}", run.stdout);
    }
}
