//! Scheduler runner — the tokio fiber that polls the `schedules` table and
//! fires HTTP callbacks for due rows.
//!
//! The fiber is intentionally simple:
//!   1. Sleep `poll_interval`.
//!   2. Query rows where `enabled=1 AND next_run_at <= now`.
//!   3. For each due row, fire its HTTP request, capture status + body, and
//!      record the result + recompute `next_run_at` from the cron expression.
//!
//! It does *not* try to make up missed fires (no catch-up): if the daemon was
//! down for an hour and a "every 5min" job missed 12 fires, the next tick
//! fires it once and resumes. This matches user intuition (cron itself does
//! the same on most systems) and avoids a thundering-herd backlog after a
//! restart.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use gctrl_core::{ScheduleRunUpdate, SchedulerConfig};
use gctrl_storage::SqliteStore;
use tracing::{debug, error, info, warn};

use crate::cron::next_after;

const RESPONSE_PREVIEW_BYTES: usize = 4_096;

pub struct ScheduleRunner {
    store: Arc<SqliteStore>,
    config: SchedulerConfig,
    http: reqwest::Client,
}

impl ScheduleRunner {
    pub fn new(store: Arc<SqliteStore>, config: SchedulerConfig) -> Self {
        Self {
            store,
            config,
            http: reqwest::Client::new(),
        }
    }

    /// Run forever. Cancellation is via dropping the parent runtime — same
    /// pattern as `gctrl-orch::Worker::run_forever`.
    pub async fn run_forever(self) {
        if !self.config.enabled {
            info!("scheduler: disabled by config; runner not started");
            return;
        }
        info!(
            poll_interval_secs = self.config.poll_interval_secs,
            "scheduler: runner started"
        );
        // Backfill `next_run_at` for any schedule that has none (e.g. created
        // while the daemon was down). One pass on startup; the runner loop
        // recomputes on every fire after that.
        self.backfill_next_run().await;

        loop {
            if let Err(e) = self.tick().await {
                error!("scheduler: tick failed: {e:#}");
            }
            tokio::time::sleep(Duration::from_secs(self.config.poll_interval_secs)).await;
        }
    }

    /// One pass over due schedules. Public for tests.
    pub async fn tick(&self) -> anyhow::Result<usize> {
        let now = Utc::now();
        let due = self
            .store
            .list_due_schedules(&now.to_rfc3339(), self.config.max_per_tick)
            .map_err(|e| anyhow::anyhow!("list_due_schedules: {e}"))?;
        if due.is_empty() {
            debug!("scheduler: no due schedules");
            return Ok(0);
        }
        let n = due.len();
        for sched in due {
            self.fire_one(sched).await;
        }
        Ok(n)
    }

    async fn fire_one(&self, sched: gctrl_core::Schedule) {
        let started = std::time::Instant::now();
        let timeout_secs = if sched.timeout_secs > 0 {
            sched.timeout_secs as u64
        } else {
            self.config.default_timeout_secs
        };
        let method = match sched.target_method.to_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            "PATCH" => reqwest::Method::PATCH,
            _ => reqwest::Method::POST,
        };
        let mut req = self
            .http
            .request(method, &sched.target_url)
            .timeout(Duration::from_secs(timeout_secs));
        if let Some(body) = &sched.body_json {
            req = req.json(body);
        }
        if let Some(headers) = sched.headers_json.as_ref().and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(s) = v.as_str() {
                    req = req.header(k, s);
                }
            }
        }

        let outcome = match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16() as i64;
                let body = resp.text().await.unwrap_or_default();
                let preview = truncate(&body, RESPONSE_PREVIEW_BYTES);
                let success = (200..400).contains(&status);
                if success {
                    info!(
                        schedule = %sched.name,
                        status = status,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "scheduler: fire ok"
                    );
                } else {
                    warn!(
                        schedule = %sched.name,
                        status = status,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "scheduler: fire returned non-2xx"
                    );
                }
                FireOutcome {
                    success,
                    status: Some(status),
                    response: Some(preview),
                    error: None,
                }
            }
            Err(e) => {
                warn!(
                    schedule = %sched.name,
                    error = %e,
                    "scheduler: fire failed"
                );
                FireOutcome {
                    success: false,
                    status: None,
                    response: None,
                    error: Some(e.to_string()),
                }
            }
        };

        // Recompute next fire from "now" (not from previous next_run_at) so a
        // slow tick doesn't compound drift across firings.
        let now = Utc::now();
        let next = match next_after(&sched.cron, now) {
            Ok(Some(dt)) => Some(dt.to_rfc3339()),
            Ok(None) => None,
            Err(e) => {
                error!(
                    schedule = %sched.name,
                    cron = %sched.cron,
                    "scheduler: cron parse failed at next_after; disabling next_run_at: {e}"
                );
                None
            }
        };

        let update = ScheduleRunUpdate {
            last_run_at: now.to_rfc3339(),
            next_run_at: next,
            last_status: outcome.status,
            last_response: outcome.response,
            last_error: outcome.error,
            success: outcome.success,
        };
        if let Err(e) = self.store.record_schedule_run(&sched.id, &update) {
            error!(schedule = %sched.name, "scheduler: record_schedule_run failed: {e}");
        }
    }

    async fn backfill_next_run(&self) {
        let all = match self
            .store
            .list_schedules(&gctrl_core::ScheduleFilter {
                enabled: Some(true),
                ..Default::default()
            }) {
            Ok(v) => v,
            Err(e) => {
                error!("scheduler: backfill list failed: {e}");
                return;
            }
        };
        let now = Utc::now();
        for s in all {
            if s.next_run_at.is_some() {
                continue;
            }
            match next_after(&s.cron, now) {
                Ok(Some(dt)) => {
                    if let Err(e) = self.store.set_schedule_next_run(&s.id, Some(&dt.to_rfc3339()))
                    {
                        error!(schedule = %s.name, "scheduler: backfill set_next_run failed: {e}");
                    }
                }
                Ok(None) => {}
                Err(e) => warn!(schedule = %s.name, cron = %s.cron, "scheduler: backfill cron error: {e}"),
            }
        }
    }
}

struct FireOutcome {
    success: bool,
    status: Option<i64>,
    response: Option<String>,
    error: Option<String>,
}

fn truncate(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &s[..end], s.len() - end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_passthrough() {
        assert_eq!(truncate("abc", 100), "abc");
    }

    #[test]
    fn truncate_long_appends_marker() {
        let s = "x".repeat(50);
        let t = truncate(&s, 10);
        assert!(t.starts_with("xxxxxxxxxx"));
        assert!(t.contains("truncated"));
    }
}
