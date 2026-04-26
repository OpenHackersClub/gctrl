//! Axum router for `/api/schedules` — CRUD + manual run-now endpoint.
//!
//! Mounted into the main kernel router via `.merge(http::router(sqlite))`.
//! State is just `Arc<SqliteStore>`; the runner fiber owns its own state.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use gctrl_core::{Schedule, ScheduleFilter, ScheduleRunUpdate};
use gctrl_storage::SqliteStore;
use serde::{Deserialize, Serialize};

use crate::cron::next_after;
use crate::runner::read_capped_body;

pub fn router(sqlite: Arc<SqliteStore>) -> Router {
    Router::new()
        .route("/api/schedules", get(list).post(create))
        .route("/api/schedules/{id}", get(get_one).delete(delete_one))
        .route("/api/schedules/{id}/run", post(run_now))
        .route("/api/schedules/{id}/enable", post(enable))
        .route("/api/schedules/{id}/disable", post(disable))
        .with_state(sqlite)
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub enabled: Option<bool>,
    pub name_prefix: Option<String>,
}

async fn list(
    State(store): State<Arc<SqliteStore>>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let filter = ScheduleFilter {
        enabled: q.enabled,
        name_prefix: q.name_prefix,
    };
    match store.list_schedules(&filter) {
        Ok(rows) => Json(serde_json::json!({ "schedules": rows })).into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub cron: String,
    pub target_url: String,
    #[serde(default = "default_method")]
    pub target_method: String,
    pub body_json: Option<serde_json::Value>,
    pub headers_json: Option<serde_json::Value>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
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
    State(store): State<Arc<SqliteStore>>,
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
    let sched = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name,
        cron: body.cron,
        target_url: body.target_url,
        target_method: body.target_method,
        body_json: body.body_json,
        headers_json: body.headers_json,
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
    };
    match store.create_schedule(&sched) {
        Ok(()) => (StatusCode::CREATED, Json(sched)).into_response(),
        Err(e) => err500(e),
    }
}

async fn get_one(
    State(store): State<Arc<SqliteStore>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match store.get_schedule(&id) {
        Ok(Some(s)) => Json(s).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err500(e),
    }
}

async fn delete_one(
    State(store): State<Arc<SqliteStore>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match store.delete_schedule(&id) {
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
async fn run_now(
    State(store): State<Arc<SqliteStore>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let sched = match store.get_schedule(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    };
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
        .timeout(std::time::Duration::from_secs(
            sched.timeout_secs.max(1) as u64,
        ));
    if let Some(b) = &sched.body_json {
        req = req.json(b);
    }

    let (success, status, response, error) = match req.send().await {
        Ok(mut r) => {
            let st = r.status().as_u16() as i64;
            let body = read_capped_body(&mut r).await;
            ((200..400).contains(&st), Some(st), Some(body), None)
        }
        Err(e) => (false, None, None, Some(e.to_string())),
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
    if let Err(e) = store.record_schedule_run(&sched.id, &update) {
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

async fn enable(
    State(store): State<Arc<SqliteStore>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    set_enabled(&store, &id, true).await
}

async fn disable(
    State(store): State<Arc<SqliteStore>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    set_enabled(&store, &id, false).await
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
