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
    /// `Some(name)` when the schedule was registered by `gctrl app install`
    /// — the value matches `gctrl_app_installs.name`. `None` for ad-hoc
    /// schedules created via `POST /api/schedules`. Lets uninstall clean
    /// up app-owned schedules without disturbing operator-owned ones.
    #[serde(default)]
    pub app_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Derived state, computed at read time by the storage layer (never
    /// stored, never accepted on POST/PATCH). `None` on rows that
    /// haven't been through the populating fetch path — e.g. a row
    /// constructed in tests for create/insert assertions.
    ///
    /// Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<ScheduleHealth>,
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

pub const FIRE_KIND_CRON: &str = "cron";
pub const FIRE_KIND_MANUAL: &str = "manual";

pub const RUN_STATUS_SUCCESS: &str = "success";
pub const RUN_STATUS_FAILURE: &str = "failure";
pub const RUN_STATUS_TIMED_OUT: &str = "timed_out";
pub const RUN_STATUS_REFUSED: &str = "refused";
pub const RUN_STATUS_INTERRUPTED: &str = "interrupted";

/// Derived per-schedule health state, computed kernel-side (never
/// recomputed on the client) per the spec § 6.3.
///
/// `red` lands when M3 adds `alert_after_failures` /
/// `current_failure_streak`; until then a routine in sustained failure
/// stays `amber` indefinitely. The Web UI surfaces a "no alert
/// threshold set" hint on amber rows so operators notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleHealth {
    Green,
    Amber,
    Red,
    Pending,
    Paused,
}

impl ScheduleHealth {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Green => "green",
            Self::Amber => "amber",
            Self::Red => "red",
            Self::Pending => "pending",
            Self::Paused => "paused",
        }
    }
}

/// Compute health from a `Schedule` row's existing fields. Pure
/// function — no DB calls — so callers can apply it inline after
/// row fetches.
///
/// Inputs available today (M1a): `enabled`, `last_run_at`,
/// `last_status`, `last_error`, `next_run_at`. The `red` state will
/// gate on `current_failure_streak >= alert_after_failures` once
/// those columns land in M3; this function returns `Amber` instead
/// of `Red` for sustained-failure routines until then.
pub fn compute_schedule_health(s: &Schedule) -> ScheduleHealth {
    if !s.enabled {
        return ScheduleHealth::Paused;
    }
    if s.last_run_at.is_none() {
        // Enabled and never fired — show that we're waiting on the
        // first run, not flag it as failing.
        return ScheduleHealth::Pending;
    }
    // For HTTP rows, last_status is the HTTP code; success is 2xx/3xx.
    // For exec rows, last_status is the exit code; success is 0.
    // We don't know the kind here without re-deriving from the row;
    // the cheapest reliable signal is `last_error`: the runner only
    // sets it on failure (success path leaves it None).
    if s.last_error.is_some() {
        ScheduleHealth::Amber
    } else {
        ScheduleHealth::Green
    }
}

/// Aggregate counts returned by `GET /api/schedules/summary` (spec § 5.6).
///
/// `runs_last_24h` is sourced from `scheduler_runs` (PR-1 of M1a).
/// `spend_last_24h_usd` lands when the analytics join is wired in M1b;
/// for now the route omits the field and the SPA hides the KPI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SchedulesSummary {
    pub total: i64,
    pub by_health: SchedulesHealthCounts,
    pub runs_last_24h: SchedulesRunsCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SchedulesHealthCounts {
    pub green: i64,
    pub amber: i64,
    pub red: i64,
    pub pending: i64,
    pub paused: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SchedulesRunsCounts {
    pub success: i64,
    pub failure: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Schedule {
        let now = "2026-05-02T00:00:00Z".to_string();
        Schedule {
            id: "x".into(),
            name: "audit.codebase".into(),
            cron: "0 3 * * 1".into(),
            target_kind: TARGET_KIND_HTTP.into(),
            target_url: "http://x".into(),
            target_method: "POST".into(),
            body_json: None,
            headers_json: None,
            command: None,
            cwd: None,
            env_keys: None,
            timeout_secs: 60,
            enabled: true,
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            last_response: None,
            last_error: None,
            run_count: 0,
            failure_count: 0,
            created_at: now.clone(),
            updated_at: now,
            health: None,
        }
    }

    #[test]
    fn paused_when_disabled() {
        let s = Schedule {
            enabled: false,
            ..base()
        };
        assert_eq!(compute_schedule_health(&s), ScheduleHealth::Paused);
    }

    #[test]
    fn paused_overrides_pending_or_amber() {
        // Disabled MUST short-circuit even when other signals would
        // map to a different state.
        let s = Schedule {
            enabled: false,
            last_error: Some("boom".into()),
            ..base()
        };
        assert_eq!(compute_schedule_health(&s), ScheduleHealth::Paused);
    }

    #[test]
    fn pending_when_enabled_and_never_fired() {
        let s = Schedule {
            enabled: true,
            last_run_at: None,
            next_run_at: Some("2026-05-03T03:00:00Z".into()),
            ..base()
        };
        assert_eq!(compute_schedule_health(&s), ScheduleHealth::Pending);
    }

    #[test]
    fn green_when_last_run_succeeded() {
        let s = Schedule {
            enabled: true,
            last_run_at: Some("2026-05-02T03:00:00Z".into()),
            last_error: None,
            ..base()
        };
        assert_eq!(compute_schedule_health(&s), ScheduleHealth::Green);
    }

    #[test]
    fn amber_when_last_run_failed() {
        let s = Schedule {
            enabled: true,
            last_run_at: Some("2026-05-02T03:00:00Z".into()),
            last_error: Some("boom".into()),
            ..base()
        };
        assert_eq!(compute_schedule_health(&s), ScheduleHealth::Amber);
    }

    #[test]
    fn schedule_health_serialises_lowercase() {
        // SPA reads the JSON as-is for filtering — serialise as "green"
        // / "amber" / etc., not the variant name.
        let json = serde_json::to_string(&ScheduleHealth::Green).unwrap();
        assert_eq!(json, "\"green\"");
        let parsed: ScheduleHealth = serde_json::from_str("\"amber\"").unwrap();
        assert_eq!(parsed, ScheduleHealth::Amber);
    }
}

/// One historical fire of a `Schedule`. Persisted in `scheduler_runs`.
///
/// Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.1.
///
/// `finished_at` is `None` only while a manual `run-now` is in flight (we
/// reserve a row up-front so a daemon crash mid-fire is reapable on next
/// startup). The runner fiber writes finished rows in one shot — no `None`
/// transient there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduleRun {
    pub id: String,
    pub schedule_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// One of `success | failure | timed_out | refused | interrupted`.
    pub status: String,
    /// `cron` | `manual`.
    pub fire_kind: String,
    /// Child exit code for `target_kind=exec`. `None` for `http` rows.
    pub exit_code: Option<i64>,
    /// HTTP response status for `target_kind=http`. `None` for `exec` rows.
    pub http_status: Option<i64>,
    /// Capped + redacted preview (matches `Schedule::last_response` posture).
    pub response_preview: Option<String>,
    /// Capped + redacted preview (matches `Schedule::last_error` posture).
    pub error_preview: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
}

/// Optional filter for `list_schedule_runs` and `list_schedule_runs_global`.
/// `None` fields = no filter applied.
#[derive(Debug, Default, Clone)]
pub struct ScheduleRunFilter {
    /// RFC3339 lower bound on `started_at` (inclusive).
    pub since: Option<String>,
    /// Restrict to a particular status (`success` / `failure` / …).
    pub status: Option<String>,
    /// Cap on rows returned. `None` means apply the implementation default.
    pub limit: Option<usize>,
}
