use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

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

/// Spawn the agent binary and feed the prompt on stdin. stdout + stderr
/// are captured so the worker can post them back as a completion comment.
///
/// The agent inherits the caller's env — OTEL_EXPORTER_OTLP_ENDPOINT,
/// HTTP_PROXY etc. flow through so sessions automatically land in the
/// kernel's OTel receiver without extra wiring.
pub async fn run_agent(
    cmd: &[String],
    working_dir: &Path,
    prompt: &str,
    timeout: Duration,
) -> Result<AgentRun, SpawnError> {
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

    let result = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r?,
        Err(_) => {
            // tokio::process kills the child when dropped on timeout, but
            // we can't retrieve it now because wait_with_output consumed it.
            // We *do* return Timeout so the caller transitions to RetryQueued.
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
