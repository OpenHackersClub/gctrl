//! Schedule types for the kernel scheduler — periodic callback jobs.
//!
//! Two `target_kind` variants:
//!   * `"http"` — fire `target_method` request to `target_url`.
//!   * `"exec"` — spawn `command` (argv) under `cwd`, passing through env vars
//!     listed in `env_keys` from the daemon's own environment.
//!
//! `exec` is operator-gated by `SchedulerConfig::{exec_enabled, exec_allowed_programs}`.
//! The runner branches on `target_kind`; per-kind fields are ignored otherwise.

use serde::{Deserialize, Serialize};

pub const TARGET_KIND_HTTP: &str = "http";
pub const TARGET_KIND_EXEC: &str = "exec";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Schedule {
    pub id: String,
    /// Unique human-readable name (e.g. `uber.ingest.tick`).
    pub name: String,
    /// Standard 5- or 6-field cron expression evaluated in UTC.
    pub cron: String,
    /// `"http"` (default) or `"exec"`. Runner discriminator.
    #[serde(default = "default_target_kind")]
    pub target_kind: String,
    // ── http-only. Empty strings tolerated when `target_kind == "exec"` so
    // the NOT NULL columns stay populated without a destructive migration.
    pub target_url: String,
    pub target_method: String,
    /// Optional JSON body sent with the request. Stored as serialized JSON.
    pub body_json: Option<serde_json::Value>,
    /// Optional headers (object → key/value). Stored as serialized JSON.
    pub headers_json: Option<serde_json::Value>,
    // ── exec-only. `None` for http rows.
    /// argv. `argv[0]` MUST be an absolute path. The http create handler
    /// rejects relative paths to prevent `$PATH` injection via `cwd`.
    pub command: Option<Vec<String>>,
    /// Absolute working directory for the spawned process.
    pub cwd: Option<String>,
    /// Env var *names* to pass through from the daemon to the child. Values
    /// are never stored — only names. The runner enforces the filter at spawn.
    pub env_keys: Option<Vec<String>>,
    pub timeout_secs: i64,
    pub enabled: bool,
    /// RFC3339 UTC timestamps. `None` means never run / never computed.
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_status: Option<i64>,
    pub last_response: Option<String>,
    pub last_error: Option<String>,
    pub run_count: i64,
    pub failure_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_target_kind() -> String {
    TARGET_KIND_HTTP.to_string()
}

impl Schedule {
    pub fn is_exec(&self) -> bool {
        self.target_kind == TARGET_KIND_EXEC
    }
}

/// Optional filter for `list_schedules`. None fields = no filter applied.
#[derive(Debug, Default, Clone)]
pub struct ScheduleFilter {
    pub enabled: Option<bool>,
    pub name_prefix: Option<String>,
}

/// Update payload written after a runner attempt fires. Captures both the
/// outcome of *this* run and the precomputed next firing time so the runner
/// stays stateless.
#[derive(Debug, Clone)]
pub struct ScheduleRunUpdate {
    pub last_run_at: String,
    pub next_run_at: Option<String>,
    pub last_status: Option<i64>,
    pub last_response: Option<String>,
    pub last_error: Option<String>,
    pub success: bool,
}
