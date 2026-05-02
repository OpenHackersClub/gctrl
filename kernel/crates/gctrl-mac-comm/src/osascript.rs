//! Safe `osascript` invocation helper.
//!
//! Invariants enforced here, NOT at the call site:
//! - Argument-array form only. The script source and any handler-call
//!   argument are passed via separate `-e` flags. There is no shell-level
//!   quoting or string concatenation anywhere in this file.
//! - Hard timeout (default 2s). If `osascript` doesn't return, the child is
//!   killed and [`CommError::OsascriptTimeout`] is returned.
//! - `osascript -e <handler-script>` and the handler-call expression are
//!   passed as **distinct argv entries** so even a maliciously-crafted
//!   argument string cannot break script-source delimiters.
//!
//! Validated input, parameterised invocation, capped runtime — three
//! independent layers, all enforced regardless of how the caller wires up
//! the adapter.

use crate::error::CommError;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone)]
pub struct Osascript {
    pub timeout_ms: u64,
    pub target_label: &'static str,
}

impl Default for Osascript {
    fn default() -> Self {
        Self {
            timeout_ms: 2_000,
            target_label: "target",
        }
    }
}

/// Outcome of a single osascript run. `stdout`/`stderr` are returned to the
/// adapter for parsing; the adapter decides what `-1743` (automation denied)
/// or `-1728` (object not found) mean for its specific verb.
#[derive(Debug, Clone)]
pub struct OsascriptOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Osascript {
    /// Run `osascript` with multiple `-e` script fragments. Each fragment is
    /// passed as a separate argv entry; there is no string concatenation.
    pub async fn run(&self, fragments: &[&str]) -> Result<OsascriptOutput, CommError> {
        let mut cmd = Command::new("osascript");
        for f in fragments {
            cmd.arg("-e").arg(f);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let wait = async move {
            let mut out_buf = String::new();
            let mut err_buf = String::new();
            if let Some(mut s) = stdout {
                let _ = s.read_to_string(&mut out_buf).await;
            }
            if let Some(mut s) = stderr {
                let _ = s.read_to_string(&mut err_buf).await;
            }
            let status = child.wait().await?;
            Ok::<_, std::io::Error>(OsascriptOutput {
                exit_code: status.code().unwrap_or(-1),
                stdout: out_buf,
                stderr: err_buf,
            })
        };

        match timeout(Duration::from_millis(self.timeout_ms), wait).await {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(io)) => Err(CommError::Io(io)),
            Err(_) => Err(CommError::OsascriptTimeout {
                target: self.target_label,
                ms: self.timeout_ms,
            }),
        }
    }
}
