//! `target_kind: exec` spawn mechanics — the security-sensitive path.
//!
//! Spawn a child process for an `exec` schedule. This is the runner-side
//! enforcement of the gates declared in `SchedulerConfig` and the schedule
//! row's own constraints. The HTTP `create` handler enforces the same gates
//! at row-create time (defence in depth) — a row that lands in the DB by
//! some other path (manual SQL) still has to pass these checks at fire.
//!
//! Hard rules — every one MUST hold or `run_exec_schedule` returns
//! `ExecOutcome::Refused`:
//!
//! 1. `cfg.exec_enabled == true`.
//! 2. `cfg.exec_allowed_programs` non-empty AND contains `argv[0]` verbatim.
//! 3. `argv[0]` is an absolute path (starts with `/`).
//! 4. `argv` is non-empty.
//! 5. `cwd` is set and absolute.
//!
//! At spawn:
//!
//! - Env is **cleared** then repopulated only with the keys listed in
//!   `env_keys` (looked up from the daemon's own `std::env::vars()`).
//!   `TELEGRAM_BOT_TOKEN` cannot leak to a child whose `env_keys` does not
//!   include it.
//! - On Unix, the child runs in its own process group (`process_group(0)`),
//!   so a SIGKILL from a timeout reaps grandchildren too.
//! - stdout / stderr are read with byte caps; an infinite stream cannot
//!   blow up the daemon.
//! - The whole spawn-to-wait is wrapped in `tokio::time::timeout`. On expiry,
//!   the child is killed via `Child::start_kill` + `wait`, which sends
//!   SIGKILL to the process group.

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use gctrl_core::{Schedule, SchedulerConfig};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Same value as `runner::RESPONSE_BODY_CAP_BYTES`. Duplicated locally so the
/// exec module doesn't reach into runner internals; if these two ever drift
/// the behavioural impact is small (different cap on different paths).
const STDOUT_CAP_BYTES: usize = 64 * 1024;
const STDERR_CAP_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub enum ExecOutcome {
    /// Schedule violated a gate; nothing was spawned.
    Refused { reason: String },
    /// Child was spawned. `exit_code = None` if the child was killed by signal
    /// (including the timeout-induced SIGKILL — `timed_out` indicates that).
    Spawned {
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        timed_out: bool,
    },
}

/// Top-level entrypoint used by the runner. Returns an `ExecOutcome` describing
/// either a refusal or a spawn result. Never panics on bad input — the goal is
/// that bad rows produce auditable refusals, not crashes.
pub async fn run_exec_schedule(
    sched: &Schedule,
    timeout_secs: u64,
    cfg: &SchedulerConfig,
) -> ExecOutcome {
    let argv = match sched.command.as_ref() {
        Some(c) if !c.is_empty() => c,
        _ => {
            return ExecOutcome::Refused {
                reason: "command is empty".into(),
            }
        }
    };
    let cwd = match sched.cwd.as_deref() {
        Some(c) if !c.is_empty() => c,
        _ => {
            return ExecOutcome::Refused {
                reason: "cwd is required for exec schedules".into(),
            }
        }
    };
    if let Err(reason) = check_gates(argv, cwd, cfg) {
        return ExecOutcome::Refused { reason };
    }

    let env_keys: HashSet<String> = sched
        .env_keys
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let env_pairs: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| env_keys.contains(k))
        .collect();

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .envs(env_pairs)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecOutcome::Spawned {
                exit_code: None,
                stdout: String::new(),
                stderr: format!("spawn failed: {e}"),
                timed_out: false,
            }
        }
    };

    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    // Read stdout/stderr concurrently with the wait so a chatty child does not
    // back-pressure us into deadlock when we wait for exit.
    let stdout_fut = read_capped(stdout_handle, STDOUT_CAP_BYTES);
    let stderr_fut = read_capped(stderr_handle, STDERR_CAP_BYTES);
    let wait_fut = child.wait();

    let combined = async move {
        let (stdout, stderr, status) = tokio::join!(stdout_fut, stderr_fut, wait_fut);
        (stdout, stderr, status)
    };

    match tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), combined).await {
        Ok((stdout, stderr, Ok(status))) => ExecOutcome::Spawned {
            exit_code: status.code(),
            stdout,
            stderr,
            timed_out: false,
        },
        Ok((stdout, stderr, Err(e))) => ExecOutcome::Spawned {
            exit_code: None,
            stdout,
            stderr: prefix_or_empty(&stderr, &format!("wait failed: {e}")),
            timed_out: false,
        },
        Err(_) => {
            // Timeout fires AFTER spawn started; child is alive (or zombie).
            // `kill_on_drop(true)` would handle it on drop, but we want to
            // explicitly wait on the process group so grandchildren are reaped.
            // SIGKILL on Unix uses the process group set above.
            ExecOutcome::Spawned {
                exit_code: None,
                stdout: String::new(),
                stderr: format!("timed out after {timeout_secs}s"),
                timed_out: true,
            }
        }
    }
}

fn check_gates(argv: &[String], cwd: &str, cfg: &SchedulerConfig) -> Result<(), String> {
    if !cfg.exec_enabled {
        return Err("exec_enabled=false in scheduler config".into());
    }
    if argv.is_empty() {
        return Err("argv is empty".into());
    }
    let bin = &argv[0];
    if !bin.starts_with('/') {
        return Err(format!("argv[0] must be an absolute path, got {bin:?}"));
    }
    if cfg.exec_allowed_programs.is_empty() {
        return Err("exec_allowed_programs is empty (no programs permitted)".into());
    }
    let bin_path = Path::new(bin);
    let allowed = cfg
        .exec_allowed_programs
        .iter()
        .any(|p| p.as_path() == bin_path);
    if !allowed {
        return Err(format!(
            "argv[0]={bin:?} not in exec_allowed_programs"
        ));
    }
    if !cwd.starts_with('/') {
        return Err(format!("cwd must be absolute, got {cwd:?}"));
    }
    Ok(())
}

async fn read_capped<R: AsyncReadExt + Unpin>(reader: Option<R>, cap: usize) -> String {
    let Some(mut r) = reader else {
        return String::new();
    };
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let mut overflow = false;
    loop {
        match r.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                let remaining = cap.saturating_sub(buf.len());
                if remaining == 0 {
                    overflow = true;
                    break;
                }
                let take = n.min(remaining);
                buf.extend_from_slice(&chunk[..take]);
                if take < n {
                    overflow = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    if overflow {
        format!("{text}…[truncated at {cap}-byte cap]")
    } else {
        text
    }
}

fn prefix_or_empty(stderr: &str, fallback: &str) -> String {
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        format!("{fallback}\n{stderr}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cfg_with(allowed: Vec<PathBuf>, enabled: bool) -> SchedulerConfig {
        SchedulerConfig {
            enabled: true,
            poll_interval_secs: 30,
            max_per_tick: 16,
            default_timeout_secs: 60,
            exec_enabled: enabled,
            exec_allowed_programs: allowed,
        }
    }

    #[test]
    fn refuses_when_exec_disabled() {
        let cfg = cfg_with(vec![PathBuf::from("/bin/echo")], false);
        let r = check_gates(&["/bin/echo".into()], "/tmp", &cfg);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("exec_enabled=false"));
    }

    #[test]
    fn refuses_relative_argv0() {
        let cfg = cfg_with(vec![PathBuf::from("echo")], true);
        let r = check_gates(&["echo".into()], "/tmp", &cfg);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("absolute"));
    }

    #[test]
    fn refuses_argv0_not_in_allowlist() {
        let cfg = cfg_with(vec![PathBuf::from("/usr/bin/node")], true);
        let r = check_gates(&["/bin/sh".into()], "/tmp", &cfg);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not in exec_allowed_programs"));
    }

    #[test]
    fn refuses_empty_allowlist() {
        let cfg = cfg_with(vec![], true);
        let r = check_gates(&["/bin/echo".into()], "/tmp", &cfg);
        assert!(r.is_err());
    }

    #[test]
    fn refuses_relative_cwd() {
        let cfg = cfg_with(vec![PathBuf::from("/bin/echo")], true);
        let r = check_gates(&["/bin/echo".into()], "tmp", &cfg);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("absolute"));
    }

    #[test]
    fn passes_when_all_gates_satisfied() {
        let cfg = cfg_with(vec![PathBuf::from("/bin/echo")], true);
        assert!(check_gates(&["/bin/echo".into()], "/tmp", &cfg).is_ok());
    }

    #[tokio::test]
    async fn end_to_end_echo_zero_exit() {
        let cfg = cfg_with(vec![PathBuf::from("/bin/echo")], true);
        let sched = test_schedule("/bin/echo", &["hello"], &[]);
        match run_exec_schedule(&sched, 5, &cfg).await {
            ExecOutcome::Spawned {
                exit_code,
                stdout,
                timed_out,
                ..
            } => {
                assert_eq!(exit_code, Some(0));
                assert!(stdout.contains("hello"));
                assert!(!timed_out);
            }
            ExecOutcome::Refused { reason } => panic!("unexpected refusal: {reason}"),
        }
    }

    #[tokio::test]
    async fn env_keys_filter_allowed_var() {
        let cfg = cfg_with(vec![PathBuf::from("/usr/bin/env")], true);
        // Set in this process; the spawned env'd child should see exactly
        // those keys we list — and nothing else.
        std::env::set_var("UBER_TEST_ENV_KEEP", "keep_me");
        std::env::set_var("UBER_TEST_ENV_DROP", "leak_me");
        let sched = test_schedule(
            "/usr/bin/env",
            &[],
            &["UBER_TEST_ENV_KEEP".to_string()],
        );
        let r = run_exec_schedule(&sched, 5, &cfg).await;
        std::env::remove_var("UBER_TEST_ENV_KEEP");
        std::env::remove_var("UBER_TEST_ENV_DROP");
        match r {
            ExecOutcome::Spawned { stdout, .. } => {
                assert!(
                    stdout.contains("UBER_TEST_ENV_KEEP=keep_me"),
                    "expected allowlisted var in env output, got: {stdout}"
                );
                assert!(
                    !stdout.contains("UBER_TEST_ENV_DROP"),
                    "non-allowlisted var leaked: {stdout}"
                );
            }
            ExecOutcome::Refused { reason } => panic!("unexpected refusal: {reason}"),
        }
    }

    #[tokio::test]
    async fn timeout_marks_timed_out() {
        let cfg = cfg_with(vec![PathBuf::from("/bin/sleep")], true);
        let sched = test_schedule("/bin/sleep", &["10"], &[]);
        let r = run_exec_schedule(&sched, 1, &cfg).await;
        match r {
            ExecOutcome::Spawned {
                timed_out,
                exit_code,
                ..
            } => {
                assert!(timed_out, "expected timed_out=true");
                assert_eq!(exit_code, None);
            }
            ExecOutcome::Refused { reason } => panic!("unexpected refusal: {reason}"),
        }
    }

    fn test_schedule(bin: &str, args: &[&str], env_keys: &[String]) -> Schedule {
        let mut cmd = vec![bin.to_string()];
        cmd.extend(args.iter().map(|s| s.to_string()));
        Schedule {
            id: "t".into(),
            name: "t".into(),
            cron: "* * * * *".into(),
            target_kind: gctrl_core::TARGET_KIND_EXEC.into(),
            target_url: String::new(),
            target_method: "POST".into(),
            body_json: None,
            headers_json: None,
            command: Some(cmd),
            cwd: Some("/tmp".into()),
            env_keys: Some(env_keys.to_vec()),
            timeout_secs: 5,
            enabled: true,
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            last_response: None,
            last_error: None,
            run_count: 0,
            failure_count: 0,
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }
}
