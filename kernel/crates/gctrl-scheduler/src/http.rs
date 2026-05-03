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
use crate::redact::redact_and_truncate;
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
        // Cross-schedule run feed + prune route + summary — registered
        // BEFORE `/api/schedules/{id}` so axum's longest-match routing
        // doesn't shadow them with the dynamic-id route.
        .route(
            "/api/schedules/runs",
            get(list_runs_global).delete(delete_runs_before),
        )
        .route("/api/schedules/summary", get(get_summary))
        .route(
            "/api/schedules/{id}",
            get(get_one).patch(patch_schedule).delete(delete_one),
        )
        .route("/api/schedules/{id}/runs", get(list_runs_for_schedule))
        .route("/api/schedules/{id}/run", post(run_now))
        .route("/api/schedules/{id}/enable", post(enable))
        .route("/api/schedules/{id}/disable", post(disable))
        .with_state(state)
}

/// Reserved prefix for daemon-managed schedules (e.g.
/// `_internal.scheduler_runs_gc`). Rejected at `POST /api/schedules`
/// from any caller — the daemon registers internal rows via the private
/// `SqliteStore::create_schedule_internal` helper, NOT through HTTP.
///
/// Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.4.
const INTERNAL_NAME_PREFIX: &str = "_internal.";

/// Format a 403 response body matching the existing 400 error shape.
fn forbidden(msg: impl Into<String>) -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": msg.into() })),
    )
        .into_response()
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
    // Reject `_internal.*` names early — the prefix is reserved for
    // daemon-managed bootstrap rows. An agent with vault write access
    // could otherwise mint a forever-running `_internal.exfil` schedule
    // and have it look like a built-in.
    if body.name.starts_with(INTERNAL_NAME_PREFIX) {
        return forbidden(format!(
            "schedule name {INTERNAL_NAME_PREFIX:?} prefix is reserved for daemon-managed rows"
        ));
    }
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
                health: None,
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
                health: None,
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
                Some(redact_and_truncate(
                    &format!("refused: {reason}"),
                    ERROR_PREVIEW_BYTES,
                )),
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
                // Apply redaction to stdout for parity with the cron path.
                // Empty stdout stays None; non-empty goes through the same
                // redact-then-truncate pipeline.
                let resp = if stdout.is_empty() {
                    None
                } else {
                    Some(redact_and_truncate(
                        &stdout,
                        crate::runner::ERROR_PREVIEW_BYTES.max(4_096),
                    ))
                };
                let err = if success {
                    None
                } else if timed_out {
                    Some(format!("timed out after {timeout_secs}s"))
                } else {
                    Some(redact_and_truncate(&stderr, ERROR_PREVIEW_BYTES))
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
    // Same single-tx write the cron path uses. Manual fires share the
    // crash-safety guarantee; only the `fire_kind = manual` tag differs.
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
    if let Err(e) = state.store.record_schedule_run_v2(&sched.id, &run_row, &update) {
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

#[derive(Debug, Deserialize)]
pub struct PruneQuery {
    /// RFC3339 timestamp; rows whose `started_at < before` are deleted.
    /// Required — without it we'd have to define an implicit "what does
    /// "all" mean" semantic, which is exactly the kind of footgun the
    /// route is supposed to avoid.
    pub before: String,
}

/// `DELETE /api/schedules/runs?before=<RFC3339>` — idempotent prune.
///
/// Powers the `_internal.scheduler_runs_gc` routine that the daemon
/// self-bootstraps on startup. Same `before` argument twice deletes
/// nothing the second call. Auth lives at the layer above: the existing
/// `host_allowlist_middleware` restricts the kernel HTTP API to
/// `localhost`, so this route is only reachable from the operator's
/// own machine.
async fn delete_runs_before(
    State(state): State<RouterState>,
    Query(q): Query<PruneQuery>,
) -> impl IntoResponse {
    // Validate `before` parses as RFC3339 — the SQLite comparison is
    // string-lexical, so a malformed value would silently match nothing
    // (or worse, match unexpectedly). Reject up-front.
    if chrono::DateTime::parse_from_rfc3339(&q.before).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("`before` must be RFC3339, got {:?}", q.before),
            })),
        )
            .into_response();
    }
    match state.store.delete_schedule_runs_before(&q.before) {
        Ok(deleted) => Json(serde_json::json!({ "deleted": deleted })).into_response(),
        Err(e) => err500(e),
    }
}

/// Allowed patch keys per spec § 5.2. `target_kind` and `name` are
/// identity and intentionally absent — changing them requires DELETE +
/// POST to force a new identity (and a new history bucket). Unknown
/// keys MUST 400 — fail closed.
const PATCHABLE_KEYS: &[&str] = &[
    "cron",
    "target_url",
    "target_method",
    "body_json",
    "headers_json",
    "command",
    "cwd",
    "env_keys",
    "timeout_secs",
    "enabled",
];

/// `PATCH /api/schedules/{id_or_name}` — RFC 7396 JSON Merge Patch over
/// the patchable fields of an existing schedule.
///
/// Field absence is a no-op; explicit `null` clears the field (where the
/// column is nullable). Every create-time gate re-runs against the
/// merged view: cron parses, exec allowlist, absolute argv[0], absolute
/// cwd, and the http/exec mutual-exclusion check that prevents lateral
/// upgrade of an http row by adding a `command` array post-creation.
///
/// Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.2.
async fn patch_schedule(
    State(state): State<RouterState>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Normalise the body to an object — RFC 7396 only defines patch for
    // JSON objects. A scalar / array payload is a 400.
    let patch = match body {
        serde_json::Value::Object(m) => m,
        _ => return bad_request("PATCH body MUST be a JSON object"),
    };

    // Fail closed on unknown keys — silently ignoring would let a typo
    // ("crone": "...") look like a successful patch.
    for k in patch.keys() {
        if !PATCHABLE_KEYS.contains(&k.as_str()) {
            return bad_request(format!(
                "unknown or non-patchable field {k:?} (allowed: {PATCHABLE_KEYS:?})"
            ));
        }
    }

    // Fetch the current row. 404 short-circuits before any validation.
    let mut merged = match state.store.get_schedule(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    };

    // Apply each patch key onto the merged view. RFC 7396 semantics:
    // missing key = no-op (already handled by `if let Some(...)`),
    // explicit `null` = clear (set to None), value = set.
    if let Some(v) = patch.get("cron") {
        merged.cron = match v.as_str() {
            Some(s) => s.to_string(),
            None => return bad_request("cron MUST be a string"),
        };
    }
    if let Some(v) = patch.get("target_url") {
        merged.target_url = match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => String::new(),
            _ => return bad_request("target_url MUST be a string or null"),
        };
    }
    if let Some(v) = patch.get("target_method") {
        merged.target_method = match v.as_str() {
            Some(s) => s.to_string(),
            None => return bad_request("target_method MUST be a string"),
        };
    }
    if let Some(v) = patch.get("body_json") {
        merged.body_json = if v.is_null() { None } else { Some(v.clone()) };
    }
    if let Some(v) = patch.get("headers_json") {
        merged.headers_json = if v.is_null() { None } else { Some(v.clone()) };
    }
    if let Some(v) = patch.get("command") {
        merged.command = match v {
            serde_json::Value::Null => None,
            serde_json::Value::Array(arr) => {
                let mut argv = Vec::with_capacity(arr.len());
                for item in arr {
                    match item.as_str() {
                        Some(s) => argv.push(s.to_string()),
                        None => return bad_request("command items MUST be strings"),
                    }
                }
                Some(argv)
            }
            _ => return bad_request("command MUST be an array of strings or null"),
        };
    }
    if let Some(v) = patch.get("cwd") {
        merged.cwd = match v {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.clone()),
            _ => return bad_request("cwd MUST be a string or null"),
        };
    }
    if let Some(v) = patch.get("env_keys") {
        merged.env_keys = match v {
            serde_json::Value::Null => None,
            serde_json::Value::Array(arr) => {
                let mut keys = Vec::with_capacity(arr.len());
                for item in arr {
                    match item.as_str() {
                        Some(s) => keys.push(s.to_string()),
                        None => return bad_request("env_keys items MUST be strings"),
                    }
                }
                Some(keys)
            }
            _ => return bad_request("env_keys MUST be an array of strings or null"),
        };
    }
    if let Some(v) = patch.get("timeout_secs") {
        merged.timeout_secs = match v.as_i64() {
            Some(n) => n,
            None => return bad_request("timeout_secs MUST be an integer"),
        };
    }
    if let Some(v) = patch.get("enabled") {
        merged.enabled = match v.as_bool() {
            Some(b) => b,
            None => return bad_request("enabled MUST be a boolean"),
        };
    }

    // Cron always re-validates (covers both PATCH-included-cron and
    // PATCH-touched-other-fields-with-stale-cron). On a fresh cron
    // value, `next_run_at` recomputes from `Utc::now()`.
    let now = Utc::now();
    let next = match next_after(&merged.cron, now) {
        Ok(opt) => opt.map(|dt| dt.to_rfc3339()),
        Err(e) => return bad_request(format!("invalid cron: {e}")),
    };
    // `next_run_at` lifecycle on PATCH:
    //   - cron change      → recompute (from `merged.enabled`)
    //   - enabled: false   → clear (so the runner does not pick up a
    //                       stale due-date once we re-enable)
    //   - enabled: true    → recompute (mirrors `set_enabled(true)`)
    //   - other            → leave alone
    if patch.contains_key("cron") {
        merged.next_run_at = if merged.enabled { next.clone() } else { None };
    } else if patch.contains_key("enabled") {
        merged.next_run_at = if merged.enabled { next.clone() } else { None };
    }

    // Cross-field validation against the MERGED view — the central
    // security check from spec § 5.2 + § 4.2: an attacker mustn't be
    // able to laterally upgrade an http row by adding a `command`
    // array, nor neuter an exec row by setting a `target_url`.
    if let Err(reason) = validate_merged_view(&merged, &state.cfg) {
        return bad_request(reason);
    }

    match state.store.update_schedule_patch(&merged) {
        Ok(true) => Json(merged).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err500(e),
    }
}

/// Re-run every create-time gate against a merged-view `Schedule`. The
/// input is the proposed post-patch row; validation MUST treat it as
/// adversarial (an attacker authoring a vault file the reconciler
/// later POSTs cannot rely on partial updates skipping checks).
fn validate_merged_view(s: &Schedule, cfg: &SchedulerConfig) -> std::result::Result<(), String> {
    match s.target_kind.as_str() {
        TARGET_KIND_HTTP => {
            if s.target_url.trim().is_empty() {
                return Err("target_url is required for target_kind=http".into());
            }
            // Mutual exclusion: http rows MUST NOT carry exec fields
            // post-merge — this is the lateral-upgrade defence.
            if s.command.as_ref().is_some_and(|c| !c.is_empty()) {
                return Err(
                    "command MUST NOT be set on an http row (DELETE + POST to change target_kind)"
                        .into(),
                );
            }
            if s.cwd.as_ref().is_some_and(|c| !c.is_empty()) {
                return Err(
                    "cwd MUST NOT be set on an http row (DELETE + POST to change target_kind)"
                        .into(),
                );
            }
            if s.env_keys.as_ref().is_some_and(|k| !k.is_empty()) {
                return Err(
                    "env_keys MUST NOT be set on an http row (DELETE + POST to change target_kind)"
                        .into(),
                );
            }
            Ok(())
        }
        TARGET_KIND_EXEC => {
            if !cfg.exec_enabled {
                return Err(
                    "exec target_kind requires scheduler.exec_enabled=true in daemon config".into(),
                );
            }
            if !s.target_url.is_empty() {
                return Err(
                    "target_url MUST NOT be set on an exec row (DELETE + POST to change target_kind)"
                        .into(),
                );
            }
            let cmd = s
                .command
                .as_ref()
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
            let cwd = s
                .cwd
                .as_deref()
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "cwd is required for target_kind=exec".to_string())?;
            if !cwd.starts_with('/') {
                return Err(format!("cwd must be absolute (got {cwd:?})"));
            }
            Ok(())
        }
        other => Err(format!(
            "unknown target_kind {other:?} (allowed: \"http\", \"exec\")"
        )),
    }
}

fn bad_request(msg: impl Into<String>) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg.into() })),
    )
        .into_response()
}

/// `GET /api/schedules/summary` — kernel-computed rollup powering the
/// /schedule page's KPI strip. SPA never recomputes the counts. Spec §5.6.
async fn get_summary(State(state): State<RouterState>) -> impl IntoResponse {
    let since = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    match state.store.schedules_summary(&since) {
        Ok(summary) => Json(summary).into_response(),
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
