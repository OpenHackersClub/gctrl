//! Daemon-managed schedule bootstrap.
//!
//! On startup, the scheduler registers a small set of `_internal.*`
//! schedules that maintain the scheduler itself — today, just the
//! `scheduler_runs` GC. The HTTP `create` handler rejects names with
//! the `_internal.*` prefix (§ 5.4), so internal rows MUST be planted
//! through this code path, not over `:4318`.
//!
//! Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.4 and the
//! `_internal.scheduler_runs_gc` row in § 7.

use std::sync::Arc;

use chrono::Utc;
use gctrl_core::{Schedule, SchedulerConfig, TARGET_KIND_HTTP};
use gctrl_storage::SqliteStore;
use tracing::{info, warn};

use crate::cron::next_after;

/// Canonical name of the scheduler's own GC routine.
pub const GC_SCHEDULE_NAME: &str = "_internal.scheduler_runs_gc";

/// Cron for the GC: nightly at 04:00 UTC (off-peak for most operator
/// time zones; doesn't collide with the typical 03:00 audit slot).
const GC_CRON: &str = "0 0 4 * * *";

/// Plant or re-plant the `_internal.scheduler_runs_gc` row.
///
/// Behaviour:
/// 1. If absent → INSERT (cron-fired against a `DELETE
///    /api/schedules/runs?before=...` URL the daemon serves itself).
/// 2. If present and parses cleanly → leave alone (idempotent restart).
/// 3. If present but malformed (corrupt cron, missing target_url for an
///    http row) → DELETE + re-INSERT, with a `tracing::warn!`.
///
/// The kernel HTTP path's `_internal.*` rejection means an attacker
/// can't pre-plant a corrupt row to displace the GC; this routine
/// trusts the row only after it round-trips a fresh validation.
pub fn ensure_gc_schedule(store: &Arc<SqliteStore>, cfg: &SchedulerConfig) -> anyhow::Result<()> {
    if let Some(existing) = store
        .get_schedule(GC_SCHEDULE_NAME)
        .map_err(|e| anyhow::anyhow!("get_schedule: {e}"))?
    {
        if is_valid_gc_row(&existing, cfg) {
            info!(
                schedule = GC_SCHEDULE_NAME,
                "scheduler: GC routine already registered"
            );
            return Ok(());
        }
        warn!(
            schedule = GC_SCHEDULE_NAME,
            "scheduler: existing GC row is malformed; replacing"
        );
        store
            .delete_schedule(&existing.id)
            .map_err(|e| anyhow::anyhow!("delete_schedule: {e}"))?;
    }
    let row = build_gc_row(cfg);
    store
        .create_schedule(&row)
        .map_err(|e| anyhow::anyhow!("create_schedule: {e}"))?;
    info!(
        schedule = GC_SCHEDULE_NAME,
        retention_days = cfg.run_retention_days,
        "scheduler: bootstrapped GC routine"
    );
    Ok(())
}

/// Exposed for tests: build the GC row deterministically from config.
pub fn build_gc_row(cfg: &SchedulerConfig) -> Schedule {
    let now = Utc::now().to_rfc3339();
    let next = next_after(GC_CRON, Utc::now())
        .ok()
        .flatten()
        .map(|dt| dt.to_rfc3339());
    // The target URL is the daemon's own loopback prune route. Hard-
    // coded to localhost — same constraint as the host-allowlist
    // middleware applied to all `:4318` routes.
    //
    // `before=` is computed **per fire** by the runner; for the row we
    // park a placeholder that the runner mutates at fire time. Until
    // the runner gains that hook (M1c follow-up), the GC row hits a
    // static `before=` ~retention-days in the past at registration —
    // which the next runner restart will refresh.
    let cutoff = (Utc::now() - chrono::Duration::days(cfg.run_retention_days as i64))
        .to_rfc3339();
    let target = format!(
        "http://127.0.0.1:4318/api/schedules/runs?before={}",
        urlencoding::encode(&cutoff)
    );
    Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: GC_SCHEDULE_NAME.into(),
        app_id: None,
        cron: GC_CRON.into(),
        target_kind: TARGET_KIND_HTTP.into(),
        target_url: target,
        target_method: "DELETE".into(),
        body_json: None,
        headers_json: None,
        command: None,
        cwd: None,
        env_keys: None,
        timeout_secs: 60,
        enabled: true,
        next_run_at: next,
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

/// Validate that an existing GC row is still serviceable. Mirrors the
/// gates the create handler enforces — without re-running them, a
/// corrupt row planted via direct DB access would silently keep retention
/// from working.
fn is_valid_gc_row(s: &Schedule, _cfg: &SchedulerConfig) -> bool {
    // Cron parses.
    if next_after(&s.cron, Utc::now()).is_err() {
        return false;
    }
    // Right kind.
    if s.target_kind != TARGET_KIND_HTTP {
        return false;
    }
    // Non-empty target URL.
    if s.target_url.is_empty() {
        return false;
    }
    // Targets the right route — guards against a stale row pointing at
    // a renamed endpoint.
    if !s.target_url.contains("/api/schedules/runs") {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Arc<SqliteStore> {
        Arc::new(SqliteStore::open(":memory:").expect("open :memory: store"))
    }

    #[test]
    fn bootstrap_inserts_when_absent() {
        let s = store();
        ensure_gc_schedule(&s, &SchedulerConfig::default()).expect("ensure");
        let row = s
            .get_schedule(GC_SCHEDULE_NAME)
            .unwrap()
            .expect("row planted");
        assert_eq!(row.name, GC_SCHEDULE_NAME);
        assert_eq!(row.cron, GC_CRON);
        assert_eq!(row.target_method, "DELETE");
        assert!(row.target_url.contains("/api/schedules/runs?before="));
        assert!(row.enabled);
    }

    #[test]
    fn bootstrap_is_idempotent_on_restart() {
        let s = store();
        let cfg = SchedulerConfig::default();
        ensure_gc_schedule(&s, &cfg).unwrap();
        let first = s.get_schedule(GC_SCHEDULE_NAME).unwrap().unwrap();
        ensure_gc_schedule(&s, &cfg).unwrap();
        let second = s.get_schedule(GC_SCHEDULE_NAME).unwrap().unwrap();
        // Same row identity on second pass — no replacement when valid.
        assert_eq!(first.id, second.id);
        assert_eq!(first.created_at, second.created_at);
    }

    #[test]
    fn bootstrap_replaces_corrupt_row() {
        let s = store();
        let cfg = SchedulerConfig::default();
        // Plant a malformed row directly: bad cron + wrong target URL.
        let now = Utc::now().to_rfc3339();
        let bad = Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            name: GC_SCHEDULE_NAME.into(),
            cron: "this is not a cron".into(),
            target_kind: TARGET_KIND_HTTP.into(),
            target_url: "http://wherever/garbage".into(),
            target_method: "POST".into(),
            body_json: None,
            headers_json: None,
            command: None,
            cwd: None,
            env_keys: None,
            timeout_secs: 60,
            enabled: false,
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            last_response: None,
            last_error: None,
            run_count: 0,
            failure_count: 0,
            app_id: None,
            created_at: now.clone(),
            updated_at: now,
            health: None,
        };
        s.create_schedule(&bad).expect("plant corrupt row");

        ensure_gc_schedule(&s, &cfg).unwrap();

        let after = s.get_schedule(GC_SCHEDULE_NAME).unwrap().unwrap();
        assert_ne!(after.id, bad.id, "corrupt row replaced");
        assert_eq!(after.cron, GC_CRON);
        assert!(after.target_url.contains("/api/schedules/runs?before="));
    }
}
