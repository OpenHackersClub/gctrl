//! Schedule types for the kernel scheduler — periodic HTTP-callback jobs.
//!
//! A `Schedule` is a cron-driven row in the `schedules` table that fires an
//! HTTP request to a target URL on its cron expression. The scheduler
//! daemon owns liveness; this module only defines the row shape and the
//! filter used by the list endpoint.

use serde::{Deserialize, Serialize};

/// HTTP method for the callback. Stored as VARCHAR; only POST/GET/PUT/DELETE
/// are accepted. Defaults to POST since most schedule callbacks mutate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Schedule {
    pub id: String,
    /// Unique human-readable name (e.g. `uber.ingest.tick`).
    pub name: String,
    /// Standard 5- or 6-field cron expression evaluated in UTC.
    pub cron: String,
    pub target_url: String,
    pub target_method: String,
    /// Optional JSON body sent with the request. Stored as serialized JSON.
    pub body_json: Option<serde_json::Value>,
    /// Optional headers (object → key/value). Stored as serialized JSON.
    pub headers_json: Option<serde_json::Value>,
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
