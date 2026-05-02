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
use gctrl_core::{
    ScheduleRun, ScheduleRunUpdate, SchedulerConfig, FIRE_KIND_CRON, RUN_STATUS_FAILURE,
    RUN_STATUS_REFUSED, RUN_STATUS_SUCCESS, RUN_STATUS_TIMED_OUT,
};
use gctrl_storage::SqliteStore;
use tracing::{debug, error, info, warn};

use crate::cron::next_after;
use crate::exec::{run_exec_schedule, ExecOutcome};
use crate::redact::redact_and_truncate;

/// Hard cap on bytes read from a callback response. A misconfigured or
/// malicious target could otherwise stream gigabytes into memory before we
/// truncate. We chunk-read up to this and bail; the preview field then
/// further trims to `RESPONSE_PREVIEW_BYTES` for storage.
const RESPONSE_BODY_CAP_BYTES: usize = 64 * 1024;
const RESPONSE_PREVIEW_BYTES: usize = 4_096;
/// Tighter cap on `last_error` — stderr from exec'd children may contain
/// secret-shaped output if a process echoes a token. Per the security review,
/// keep this small enough that a leak is bounded; the full stderr still goes
/// to `tracing::warn!` and the OTel span (which are read-restricted), not the
/// DB row that anyone with `:4318` access can fetch.
pub(crate) const ERROR_PREVIEW_BYTES: usize = 512;

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
        // Reap any `scheduler_runs` rows left mid-flight by a daemon crash
        // before yesterday's fires masquerade as "still running" forever.
        // `manual` rows are the only realistic source today (the cron path
        // closes the row in one go); reaping in startup keeps that
        // invariant straightforward.
        self.reap_interrupted().await;
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
        let started_wall = Utc::now();
        let started = std::time::Instant::now();
        let timeout_secs = if sched.timeout_secs > 0 {
            sched.timeout_secs as u64
        } else {
            self.config.default_timeout_secs
        };

        let outcome = if sched.is_exec() {
            self.fire_exec(&sched, timeout_secs, started).await
        } else {
            self.fire_http(&sched, timeout_secs, started).await
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
            last_response: outcome.response.clone(),
            last_error: outcome.error.clone(),
            success: outcome.success,
        };
        // Cache row UPDATE + history INSERT in one SQLite transaction so a
        // mid-fire crash leaves no half-state. M3 will fold the inbox emit
        // into the same tx; the helper signature is shaped for that.
        let run = build_run_row(&sched, &outcome, started_wall, now, FIRE_KIND_CRON);
        if let Err(e) = self.store.record_schedule_run_v2(&sched.id, &run, &update) {
            error!(schedule = %sched.name, "scheduler: record_schedule_run_v2 failed: {e}");
        }
    }

    /// HTTP target — original behaviour. Fires a request, captures status +
    /// body, returns a `FireOutcome` for `fire_one` to record.
    async fn fire_http(
        &self,
        sched: &gctrl_core::Schedule,
        timeout_secs: u64,
        started: std::time::Instant,
    ) -> FireOutcome {
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
        match req.send().await {
            Ok(mut resp) => {
                let status = resp.status().as_u16() as i64;
                let body = read_capped_body(&mut resp).await;
                // Defence-in-depth: HTTP callback responses don't usually
                // carry secret-shaped content, but a misconfigured callback
                // that echoes auth headers would leak otherwise.
                let preview = redact_and_truncate(&body, RESPONSE_PREVIEW_BYTES);
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
                    timed_out: false,
                    refused: false,
                }
            }
            Err(e) => {
                warn!(
                    schedule = %sched.name,
                    error = %e,
                    "scheduler: fire failed"
                );
                let timed_out = e.is_timeout();
                FireOutcome {
                    success: false,
                    status: None,
                    response: None,
                    error: Some(e.to_string()),
                    timed_out,
                    refused: false,
                }
            }
        }
    }

    /// `target_kind: exec` — spawn a child process under the operator's
    /// allowlisted bin path with a filtered env. See `exec::run_exec_schedule`
    /// for the spawn mechanics; this method just translates the result into
    /// the same `FireOutcome` shape `fire_http` produces.
    async fn fire_exec(
        &self,
        sched: &gctrl_core::Schedule,
        timeout_secs: u64,
        started: std::time::Instant,
    ) -> FireOutcome {
        let outcome = run_exec_schedule(sched, timeout_secs, &self.config).await;
        match outcome {
            ExecOutcome::Refused { reason } => {
                warn!(
                    schedule = %sched.name,
                    reason = %reason,
                    "scheduler: exec refused"
                );
                FireOutcome {
                    success: false,
                    status: None,
                    response: None,
                    error: Some(redact_and_truncate(
                        &format!("refused: {reason}"),
                        ERROR_PREVIEW_BYTES,
                    )),
                    timed_out: false,
                    refused: true,
                }
            }
            ExecOutcome::Spawned {
                exit_code,
                stdout,
                stderr,
                timed_out,
            } => {
                let success = !timed_out && exit_code == Some(0);
                let elapsed_ms = started.elapsed().as_millis() as u64;
                if success {
                    info!(
                        schedule = %sched.name,
                        exit_code = ?exit_code,
                        stdout_bytes = stdout.len(),
                        stderr_bytes = stderr.len(),
                        elapsed_ms,
                        "scheduler: exec ok"
                    );
                } else {
                    warn!(
                        schedule = %sched.name,
                        exit_code = ?exit_code,
                        stdout_bytes = stdout.len(),
                        stderr_bytes = stderr.len(),
                        elapsed_ms,
                        timed_out,
                        // Full stderr stays in tracing logs (which require
                        // operator access to the daemon's log stream), not in
                        // the DB row that anyone on :4318 can read.
                        stderr = %stderr,
                        "scheduler: exec failed"
                    );
                }
                let response_preview = if stdout.is_empty() {
                    None
                } else {
                    Some(redact_and_truncate(&stdout, RESPONSE_PREVIEW_BYTES))
                };
                let error_preview = if success {
                    None
                } else if timed_out {
                    Some(redact_and_truncate(
                        &format!("timed out after {timeout_secs}s"),
                        ERROR_PREVIEW_BYTES,
                    ))
                } else {
                    // Tight cap: stderr is the primary leak vector for child
                    // processes that echo secrets. Full stderr is in the log
                    // stream above; only the prefix is in the DB.
                    Some(redact_and_truncate(&stderr, ERROR_PREVIEW_BYTES))
                };
                FireOutcome {
                    success,
                    status: exit_code.map(|c| c as i64),
                    response: response_preview,
                    error: error_preview,
                    timed_out,
                    refused: false,
                }
            }
        }
    }

    async fn reap_interrupted(&self) {
        let now = Utc::now().to_rfc3339();
        match self.store.reap_interrupted_schedule_runs(&now) {
            Ok(0) => debug!("scheduler: no interrupted runs to reap"),
            Ok(n) => warn!(reaped = n, "scheduler: reaped interrupted runs from prior crash"),
            Err(e) => error!("scheduler: reap_interrupted_schedule_runs failed: {e}"),
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

/// Outcome of a single fire — produced by `fire_http` / `fire_exec` and
/// consumed by both `fire_one` (cron path) and `http::run_now` (manual path)
/// when assembling a `ScheduleRun` history row.
pub(crate) struct FireOutcome {
    pub(crate) success: bool,
    /// HTTP status (`http`) or child exit code (`exec`). The runner stuffs
    /// both into the same `i64` for storage in the `schedules.last_status`
    /// cache; `build_run_row` un-mixes them into the typed
    /// `scheduler_runs.{http_status, exit_code}` columns.
    pub(crate) status: Option<i64>,
    pub(crate) response: Option<String>,
    pub(crate) error: Option<String>,
    /// `true` iff the failure is due to the `tokio::time::timeout` wrapper
    /// expiring (exec path) or the http request timing out at the reqwest
    /// layer (http path). PR-1 only sets this for exec; http timeouts are
    /// recorded as plain `failure` until PR-2 surfaces a typed error path.
    pub(crate) timed_out: bool,
    /// `true` iff the exec path refused to spawn (gate violation). Surfaces
    /// in `scheduler_runs.status = "refused"`. Unused for http rows.
    pub(crate) refused: bool,
}

/// Translate a `FireOutcome` plus its timing into the durable history row.
///
/// `started_wall` and `finished_wall` MUST be the wall-clock UTC instants
/// captured in `fire_one` / `run_now`; `Instant::now()` is monotonic and
/// not serialisable.
pub(crate) fn build_run_row(
    sched: &gctrl_core::Schedule,
    outcome: &FireOutcome,
    started_wall: chrono::DateTime<Utc>,
    finished_wall: chrono::DateTime<Utc>,
    fire_kind: &str,
) -> ScheduleRun {
    let status = if outcome.refused {
        RUN_STATUS_REFUSED
    } else if outcome.timed_out {
        RUN_STATUS_TIMED_OUT
    } else if outcome.success {
        RUN_STATUS_SUCCESS
    } else {
        RUN_STATUS_FAILURE
    };
    // Disambiguate the `outcome.status` overload on target_kind.
    let (exit_code, http_status) = if sched.is_exec() {
        (outcome.status, None)
    } else {
        (None, outcome.status)
    };
    let duration_ms = finished_wall
        .signed_duration_since(started_wall)
        .num_milliseconds();
    ScheduleRun {
        id: uuid::Uuid::new_v4().to_string(),
        schedule_id: sched.id.clone(),
        started_at: started_wall.to_rfc3339(),
        finished_at: Some(finished_wall.to_rfc3339()),
        status: status.into(),
        fire_kind: fire_kind.into(),
        exit_code,
        http_status,
        response_preview: outcome.response.clone(),
        error_preview: outcome.error.clone(),
        duration_ms: Some(duration_ms),
        created_at: finished_wall.to_rfc3339(),
    }
}

/// Read at most `RESPONSE_BODY_CAP_BYTES` from `resp` using chunked reads.
/// Stops streaming the moment the cap is reached, so a 1 GB response body
/// only ever costs us 64 KB of buffer + whatever single chunk reqwest hands
/// us next. Made `pub(crate)` so the `run_now` HTTP handler can reuse it.
pub(crate) async fn read_capped_body(resp: &mut reqwest::Response) -> String {
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut overflow = false;
    while let Ok(Some(chunk)) = resp.chunk().await {
        if buf.len() + chunk.len() > RESPONSE_BODY_CAP_BYTES {
            let take = RESPONSE_BODY_CAP_BYTES.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            overflow = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    if overflow {
        format!(
            "{body}…[truncated at {}-byte response cap]",
            RESPONSE_BODY_CAP_BYTES
        )
    } else {
        body
    }
}

// truncate(): retired with PR-2. All callsites moved to
// `crate::redact::redact_and_truncate`, which composes redaction with
// the same UTF-8-safe byte cap. Behavioural test coverage lives in
// `redact::tests` (truncate_short_passthrough, truncate_long_appends_marker).
