use thiserror::Error;

#[derive(Debug, Error)]
pub enum CommError {
    #[error("not supported on this platform")]
    NotSupported,

    #[error("invalid {field}: must match {pattern}")]
    Validation {
        field: &'static str,
        pattern: &'static str,
    },

    #[error("unknown target: {0}")]
    UnknownTarget(String),

    #[error(
        "{target} session {session_id} not found. The window/tab may have been closed. \
        Run 'gctrl terminal capabilities' to confirm {target} is reachable, or wait for \
        the agent to re-issue the request."
    )]
    SessionNotFound {
        target: &'static str,
        session_id: String,
    },

    #[error(
        "{target} is not running. Launch it and run 'gctrl terminal focus' again."
    )]
    TargetNotRunning { target: &'static str },

    #[error(
        "Automation permission denied for {target}. Open System Settings → Privacy & \
        Security → Automation → gctrl-desktop and allow {target}. Then run \
        'gctrl terminal capabilities' to confirm the grant."
    )]
    AutomationDenied { target: &'static str },

    #[error(
        "{target} did not respond within {ms}ms. Run 'gctrl terminal capabilities' \
        to confirm reachability; retry once."
    )]
    OsascriptTimeout { target: &'static str, ms: u64 },

    #[error("osascript failed (exit {exit_code}): {stderr}")]
    OsascriptFailed { exit_code: i32, stderr: String },

    #[error(
        "Too many focus calls for session {0} in the last minute. Wait 5s and retry, \
        or 'gctrl inbox view <id>' to inspect manually."
    )]
    RateLimited(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
