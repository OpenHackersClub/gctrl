//! Axum router for `/api/schedules` — CRUD + manual run-now endpoint.
//!
//! Mounted into the main kernel router via `.merge(http::router(sqlite, cfg))`.
//! State carries the `SqliteStore` plus the `SchedulerConfig` (so the create
//! handler can enforce `exec_enabled` + `exec_allowed_programs` and `run_now`
//! can dispatch to the same exec path as the runner fiber).

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use gctrl_core::{
    Schedule, ScheduleFilter, ScheduleRunFilter, ScheduleRunUpdate, SchedulerConfig,
    TARGET_KIND_EXEC, TARGET_KIND_HTTP,
};
use gctrl_storage::SqliteStore;
use serde::{Deserialize, Serialize};

use crate::cron::next_after;
use crate::exec::{run_exec_schedule, ExecOutcome};
use crate::runner::read_capped_body;
use crate::runner::ERROR_PREVIEW_BYTES;

#[derive(Clone)]
pub struct RouterState {
    pub store: Arc<SqliteStore>,
    pub cfg: Arc<SchedulerConfig>,
}

pub fn router(sqlite: Arc<SqliteStore>, cfg: Arc<SchedulerConfig>) -> Router {
    let state = RouterState {
        store: sqlite,
        cfg,
    };
    Router::new()
        .route("/api/schedules", get(list).post(create))
        // Cross-schedule run feed — must be registered BEFORE
        // `/api/schedules/{id}` so axum's longest-match routing doesn't
        // shadow this with the dynamic-id route.
        .route("/api/schedules/runs", get(list_runs_global))
        .route("/api/schedules/{id}", get(get_one).delete(delete_one))
        .route("/api/schedules/{id}/runs", get(list_runs_for_schedule))
        .route("/api/schedules/{id}/run", post(run_now))
        .route("/api/schedules/{id}/enable", post(enable))
        .route("/api/schedules/{id}/disable", post(disable))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub enabled: Option<bool>,
    pub name_prefix: Option<String>,
}

async fn list(
    State(state): State<RouterState>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let filter = ScheduleFilter {
        enabled: q.enabled,
        name_prefix: q.name_prefix,
    };
    match state.store.list_schedules(&filter) {
        Ok(rows) => Json(serde_json::json!({ "schedules": rows })).into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub cron: String,
    /// `"http"` (default) or `"exec"`. Determines which set of fields the
    /// validator requires.
    #[serde(default = "default_target_kind")]
    pub target_kind: String,
    // http
    #[serde(default)]
    pub target_url: Option<String>,
    #[serde(default = "default_method")]
    pub target_method: String,
    pub body_json: Option<serde_json::Value>,
    pub headers_json: Option<serde_json::Value>,
    // exec
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env_keys: Option<Vec<String>>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_target_kind() -> String {
    TARGET_KIND_HTTP.into()
}
fn default_method() -> String {
    "POST".into()
}
fn default_timeout() -> i64 {
    60
}
fn default_enabled() -> bool {
    true
}

async fn create(
    State(state): State<RouterState>,
    Json(body): Json<CreateBody>,
) -> impl IntoResponse {
    // Validate cron up-front; reject 400 rather than persist a row that will
    // never fire and confuse the operator.
    let next = match next_after(&body.cron, Utc::now()) {
        Ok(opt) => opt.map(|dt| dt.to_rfc3339()),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("invalid cron: {e}") })),
            )
                .into_response();
        }
    };
    let now = Utc::now().to_rfc3339();

    let sched = match build_schedule(body, next, now, &state.cfg) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };
    match state.store.create_schedule(&sched) {
        Ok(()) => (StatusCode::CREATED, Json(sched)).into_response(),
        Err(e) => err500(e),
    }
}

/// Validate the `CreateBody` against the gates declared in `cfg` and assemble
/// a `Schedule` row. Errors are operator-readable strings — the create handler
/// renders them as 400 responses.
fn build_schedule(
    body: CreateBody,
    next: Option<String>,
    now: String,
    cfg: &SchedulerConfig,
) -> Result<Schedule, String> {
    match body.target_kind.as_str() {
        TARGET_KIND_HTTP => {
            let url = body
                .target_url
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "target_url is required for target_kind=http".to_string())?;
            if body.command.is_some() || body.cwd.is_some() || body.env_keys.is_some() {
                return Err(
                    "command/cwd/env_keys MUST NOT be set when target_kind=http".into(),
                );
            }
            Ok(Schedule {
                id: uuid::Uuid::new_v4().to_string(),
                name: body.name,
                cron: body.cron,
                target_kind: TARGET_KIND_HTTP.into(),
                target_url: url,
                target_method: body.target_method,
                body_json: body.body_json,
                headers_json: body.headers_json,
                command: None,
                cwd: None,
                env_keys: None,
                timeout_secs: body.timeout_secs,
                enabled: body.enabled,
                next_run_at: if body.enabled { next } else { None },
                last_run_at: None,
                last_status: None,
                last_response: None,
                last_error: None,
                run_count: 0,
                failure_count: 0,
                created_at: now.clone(),
                updated_at: now,
            })
        }
        TARGET_KIND_EXEC => {
            if !cfg.exec_enabled {
                return Err(
                    "exec target_kind requires scheduler.exec_enabled=true in daemon config"
                        .into(),
                );
            }
            let cmd = body
                .command
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "command is required for target_kind=exec".to_string())?;
            let bin = &cmd[0];
            if !bin.starts_with('/') {
                return Err(format!(
                    "argv[0] must be an absolute path (got {bin:?}) — relative paths are rejected to prevent $PATH-injection via cwd"
                ));
            }
            if cfg.exec_allowed_programs.is_empty() {
                return Err(
                    "scheduler.exec_allowed_programs is empty (no programs permitted)".into(),
                );
            }
            let bin_path = std::path::Path::new(bin);
            if !cfg
                .exec_allowed_programs
                .iter()
                .any(|p| p.as_path() == bin_path)
            {
                return Err(format!(
                    "argv[0]={bin:?} not in scheduler.exec_allowed_programs"
                ));
            }
            let cwd = body
                .cwd
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "cwd is required for target_kind=exec".to_string())?;
            if !cwd.starts_with('/') {
                return Err(format!("cwd must be an absolute path (got {cwd:?})"));
            }
            if body.target_url.as_deref().is_some_and(|s| !s.is_empty()) {
                return Err(
                    "target_url MUST NOT be set when target_kind=exec".into(),
                );
            }
            Ok(Schedule {
                id: uuid::Uuid::new_v4().to_string(),
                name: body.name,
                cron: body.cron,
                target_kind: TARGET_KIND_EXEC.into(),
                // Empty strings tolerated for the NOT NULL columns.
                target_url: String::new(),
                target_method: "POST".into(),
                body_json: None,
                headers_json: None,
                command: Some(cmd),
                cwd: Some(cwd),
                env_keys: Some(body.env_keys.unwrap_or_default()),
                timeout_secs: body.timeout_secs,
                enabled: body.enabled,
                next_run_at: if body.enabled { next } else { None },
                last_run_at: None,
                last_status: None,
                last_response: None,
                last_error: None,
                run_count: 0,
                failure_count: 0,
                created_at: now.clone(),
                updated_at: now,
            })
        }
        other => Err(format!(
            "unknown target_kind {other:?} (allowed: \"http\", \"exec\")"
        )),
    }
}

async fn get_one(
    State(state): State<RouterState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_schedule(&id) {
        Ok(Some(s)) => Json(s).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err500(e),
    }
}

async fn delete_one(
    State(state): State<RouterState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.delete_schedule(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Serialize)]
struct RunResult {
    id: String,
    name: String,
    fired: bool,
    status: Option<i64>,
    error: Option<String>,
}

/// Manual fire — bypasses cron, updates last_* fields, recomputes next_run_at.
/// Useful for ops ("did this thing actually work?") and as the primary tool
/// while iterating on a new schedule.
///
/// Branches on `target_kind`: HTTP rows fire a `reqwest`; exec rows go through
/// the same `run_exec_schedule` path the runner fiber uses, so a manual
/// trigger and a cron-driven trigger behave identically.
async fn run_now(
    State(state): State<RouterState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let sched = match state.store.get_schedule(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    };

    let timeout_secs = sched.timeout_secs.max(1) as u64;
    let started_wall = Utc::now();
    let (success, status, response, error, timed_out, refused) = if sched.is_exec() {
        match run_exec_schedule(&sched, timeout_secs, &state.cfg).await {
            ExecOutcome::Refused { reason } => (
                false,
                None,
                None,
                Some(truncate(&format!("refused: {reason}"), ERROR_PREVIEW_BYTES)),
                false,
                true,
            ),
            ExecOutcome::Spawned {
                exit_code,
                stdout,
                stderr,
                timed_out,
            } => {
                let success = !timed_out && exit_code == Some(0);
                let resp = if stdout.is_empty() { None } else { Some(stdout) };
                let err = if success {
                    None
                } else if timed_out {
                    Some(format!("timed out after {timeout_secs}s"))
                } else {
                    Some(truncate(&stderr, ERROR_PREVIEW_BYTES))
                };
                (success, exit_code.map(|c| c as i64), resp, err, timed_out, false)
            }
        }
    } else {
        let client = reqwest::Client::new();
        let method = match sched.target_method.to_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            "PATCH" => reqwest::Method::PATCH,
            _ => reqwest::Method::POST,
        };
        let mut req = client
            .request(method, &sched.target_url)
            .timeout(std::time::Duration::from_secs(timeout_secs));
        if let Some(b) = &sched.body_json {
            req = req.json(b);
        }
        match req.send().await {
            Ok(mut r) => {
                let st = r.status().as_u16() as i64;
                let body = read_capped_body(&mut r).await;
                (
                    (200..400).contains(&st),
                    Some(st),
                    Some(body),
                    None,
                    false,
                    false,
                )
            }
            Err(e) => {
                let timed_out = e.is_timeout();
                (false, None, None, Some(e.to_string()), timed_out, false)
            }
        }
    };

    let now = Utc::now();
    let next = next_after(&sched.cron, now)
        .ok()
        .flatten()
        .map(|dt| dt.to_rfc3339());
    let update = ScheduleRunUpdate {
        last_run_at: now.to_rfc3339(),
        next_run_at: next,
        last_status: status,
        last_response: response.clone(),
        last_error: error.clone(),
        success,
    };
    if let Err(e) = state.store.record_schedule_run(&sched.id, &update) {
        return err500(e);
    }
    // Append durable history alongside the row UPDATE. Same staging order as
    // the cron path; PR-2 collapses both into a single SQLite tx.
    let outcome = crate::runner::FireOutcome {
        success,
        status,
        response: response.clone(),
        error: error.clone(),
        timed_out,
        refused,
    };
    let run_row = crate::runner::build_run_row(
        &sched,
        &outcome,
        started_wall,
        now,
        gctrl_core::FIRE_KIND_MANUAL,
    );
    if let Err(e) = state.store.insert_schedule_run(&run_row) {
        return err500(e);
    }

    Json(RunResult {
        id: sched.id,
        name: sched.name,
        fired: success,
        status,
        error,
    })
    .into_response()
}

/// Query params shared by both run-listing endpoints.
///
/// `since` is matched literally as an RFC3339 string against
/// `scheduler_runs.started_at` in the storage layer — it doesn't accept the
/// `?since=24h` shorthand the analytics routes use because the storage filter
/// composes with prepared-statement parameters, not server-side parsing.
/// Resolve the shorthand at the caller (the SPA / shell) and pass an absolute
/// timestamp.
#[derive(Debug, Deserialize)]
pub struct RunsQuery {
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `GET /api/schedules/{id_or_name}/runs` — history for one schedule.
///
/// Resolves `id` or `name` to a row before querying so the SPA can use the
/// human-readable name in the URL just like the existing GET-by-id handler.
async fn list_runs_for_schedule(
    State(state): State<RouterState>,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> impl IntoResponse {
    let sched = match state.store.get_schedule(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    };
    let filter = ScheduleRunFilter {
        since: q.since,
        status: q.status,
        limit: q.limit,
    };
    match state.store.list_schedule_runs(&sched.id, &filter) {
        Ok(runs) => Json(serde_json::json!({
            "schedule_id": sched.id,
            "schedule_name": sched.name,
            "runs": runs,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// `GET /api/schedules/runs` — cross-schedule run feed for the top-of-page
/// failure strip on the Schedule page.
async fn list_runs_global(
    State(state): State<RouterState>,
    Query(q): Query<RunsQuery>,
) -> impl IntoResponse {
    let filter = ScheduleRunFilter {
        since: q.since,
        status: q.status,
        limit: q.limit,
    };
    match state.store.list_schedule_runs_global(&filter) {
        Ok(runs) => Json(serde_json::json!({ "runs": runs })).into_response(),
        Err(e) => err500(e),
    }
}

async fn enable(
    State(state): State<RouterState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    set_enabled(&state.store, &id, true).await
}

async fn disable(
    State(state): State<RouterState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    set_enabled(&state.store, &id, false).await
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

async fn set_enabled(store: &SqliteStore, id: &str, enabled: bool) -> axum::response::Response {
    match store.set_schedule_enabled(id, enabled) {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    }
    if enabled {
        // Recompute next_run_at on enable so a previously-disabled job fires
        // at its next cron boundary, not whatever stale value sat in the row.
        if let Ok(Some(s)) = store.get_schedule(id) {
            let next = next_after(&s.cron, Utc::now())
                .ok()
                .flatten()
                .map(|dt| dt.to_rfc3339());
            let _ = store.set_schedule_next_run(&s.id, next.as_deref());
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

fn err500<E: std::fmt::Display>(e: E) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": e.to_string() })),
    )
        .into_response()
}
