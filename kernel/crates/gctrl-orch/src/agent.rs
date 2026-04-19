use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

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
pub async fn spawn_agent(
    cmd: &[String],
    working_dir: &Path,
    prompt: &str,
) -> Result<Child, SpawnError> {
    let (program, args) = cmd
        .split_first()
        .ok_or_else(|| SpawnError::Spawn(std::io::Error::other("empty agent command")))?;

    let mut child = Command::new(program)
        .args(args)
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
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
) -> Result<AgentRun, SpawnError> {
    let child = spawn_agent(cmd, working_dir, prompt).await?;
    await_agent(child, timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_succeeds_and_captures_stdout() {
        // `cat` echoes the prompt from stdin back to stdout — a stand-in
        // agent that lets CI run without claude on the PATH.
        let run = run_agent(
            &["cat".into()],
            Path::new("."),
            "hello from worker",
            Duration::from_secs(5),
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
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SpawnError::Timeout(_)));
    }

    #[tokio::test]
    async fn missing_binary_is_reported() {
        let err = run_agent(
            &["this-binary-does-not-exist-12345".into()],
            Path::new("."),
            "",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SpawnError::Spawn(_)));
    }
}
