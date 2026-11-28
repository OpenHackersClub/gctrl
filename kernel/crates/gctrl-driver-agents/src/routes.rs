//! `/api/agents/*` routes. Contract: spec § HTTP API.

use crate::gather::{gather, GatherRequest};
use crate::index::{launch_request, AgentIndex, ListOptions};
use crate::model::{AgentRun, OpenResponse};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use gctrl_mac_comm::{launch::shell_command, CommError};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

/// List calls reuse an index refreshed within this window.
const LIST_MAX_AGE: Duration = Duration::from_secs(2);

#[derive(Debug, Default, Deserialize)]
struct ListParams {
    #[serde(default)]
    include_headless: bool,
    #[serde(default)]
    include_stale: bool,
}

#[derive(Debug, Default, Deserialize)]
struct OpenParams {
    #[serde(default)]
    dry_run: bool,
}

fn comm_status(e: &CommError) -> StatusCode {
    match e {
        CommError::NotSupported => StatusCode::NOT_IMPLEMENTED,
        CommError::Validation { .. } | CommError::UnknownTarget(_) => StatusCode::BAD_REQUEST,
        CommError::SessionNotFound { .. } => StatusCode::NOT_FOUND,
        CommError::TargetNotRunning { .. } => StatusCode::SERVICE_UNAVAILABLE,
        CommError::AutomationDenied { .. } => StatusCode::FORBIDDEN,
        CommError::OsascriptTimeout { .. } => StatusCode::GATEWAY_TIMEOUT,
        CommError::OsascriptFailed { .. } => StatusCode::BAD_GATEWAY,
        CommError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
        CommError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn comm_error(e: CommError) -> Response {
    (comm_status(&e), e.to_string()).into_response()
}

fn ok(action: &str, detail: Option<String>, command: Option<String>) -> Response {
    Json(OpenResponse {
        action: action.to_string(),
        detail,
        command,
    })
    .into_response()
}

async fn runs(index: &Arc<AgentIndex>, max_age: Duration) -> Result<Vec<AgentRun>, Response> {
    let idx = Arc::clone(index);
    tokio::task::spawn_blocking(move || idx.refresh_if_older(max_age, Utc::now()))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

async fn list(State(index): State<Arc<AgentIndex>>, Query(p): Query<ListParams>) -> Response {
    match runs(&index, LIST_MAX_AGE).await {
        Ok(r) => {
            let mut resp = AgentIndex::list(
                &r,
                ListOptions {
                    include_headless: p.include_headless,
                    include_stale: p.include_stale,
                },
                Utc::now(),
            );
            resp.gather_queue = index.gather_queue();
            Json(resp).into_response()
        }
        Err(resp) => resp,
    }
}

async fn get_one(State(index): State<Arc<AgentIndex>>, Path(id): Path<String>) -> Response {
    match runs(&index, LIST_MAX_AGE).await {
        Ok(r) => match r.into_iter().find(|x| x.id == id) {
            Some(run) => Json(run).into_response(),
            None => (StatusCode::NOT_FOUND, "unknown run").into_response(),
        },
        Err(resp) => resp,
    }
}

async fn open(
    State(index): State<Arc<AgentIndex>>,
    Path(id): Path<String>,
    Query(p): Query<OpenParams>,
) -> Response {
    // Liveness must be current: a stale "not live" would launch a duplicate.
    let all = match runs(&index, Duration::ZERO).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(run) = all.into_iter().find(|x| x.id == id) else {
        return (StatusCode::NOT_FOUND, "unknown run").into_response();
    };

    if let Some(live) = &run.live {
        let Some(tty) = live.tty.clone() else {
            return ok("none", Some("no_tty".into()), None);
        };
        if p.dry_run {
            return ok("would_focus", Some(tty), None);
        }
        return match gctrl_mac_comm::focus_tty(&tty).await {
            Ok(r) if r.focused => ok("focused", r.reason, None),
            Ok(r) => ok("none", r.reason, None),
            Err(e) => comm_error(e),
        };
    }

    if !run.cwd_exists {
        return (StatusCode::CONFLICT, "cwd_missing").into_response();
    }
    let req = launch_request(run.harness, &run.native_id, &run.cwd);
    let command = match shell_command(&req) {
        Ok(c) => c,
        Err(e) => return comm_error(e),
    };
    if p.dry_run {
        return ok("would_launch", None, Some(command));
    }
    if !index.note_launch(&run.id) {
        return ok("none", Some("launch_in_progress".into()), Some(command));
    }
    match gctrl_mac_comm::launch(&req).await {
        Ok(r) => ok("launched", Some("iTerm2".into()), Some(r.command)),
        Err(e) => comm_error(e),
    }
}

/// Mount `/api/agents/*` with its own index state.
async fn gather_runs(State(index): State<Arc<AgentIndex>>, Json(req): Json<GatherRequest>) -> Response {
    if req.ids.is_empty() {
        return (StatusCode::BAD_REQUEST, "ids is empty").into_response();
    }
    match gather(index, req).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => comm_error(e),
    }
}

async fn cancel_gather(State(index): State<Arc<AgentIndex>>, Path(id): Path<String>) -> StatusCode {
    index.dequeue_gather(&id);
    StatusCode::NO_CONTENT
}

pub fn router<S: Clone + Send + Sync + 'static>(index: Arc<AgentIndex>) -> Router<S> {
    Router::new()
        .route("/api/agents", get(list))
        .route("/api/agents/{id}", get(get_one))
        .route("/api/agents/gather", post(gather_runs))
        .route("/api/agents/{id}/open", post(open))
        .route("/api/agents/{id}/gather", axum::routing::delete(cancel_gather))
        .with_state(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Paths;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const SID: &str = "26e3373e-8358-416b-83f3-355a59325193";

    fn fake_home(tmp: &std::path::Path, cwd: &str) {
        let proj = tmp.join(".claude/projects/-w");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join(format!("{SID}.jsonl")),
            format!(
                "{}\n",
                format_args!(
                    r#"{{"type":"user","cwd":"{cwd}","timestamp":"{}","message":{{"content":"hi"}}}}"#,
                    Utc::now().to_rfc3339()
                )
            ),
        )
        .unwrap();
    }

    async fn call(app: Router, method: &str, uri: &str) -> (StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(Request::builder().method(method).uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
        (status, json)
    }

    fn app(home: &std::path::Path) -> Router {
        router::<()>(Arc::new(AgentIndex::new(Paths::from_home(home))))
    }

    #[tokio::test]
    async fn lists_runs_with_hidden_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("api");
        std::fs::create_dir_all(&cwd).unwrap();
        fake_home(tmp.path(), cwd.to_str().unwrap());
        let (status, body) = call(app(tmp.path()), "GET", "/api/agents").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["runs"][0]["id"], format!("claude:{SID}"));
        assert_eq!(body["runs"][0]["state"], "resumable");
        assert_eq!(body["hidden"]["stale"], 0);
    }

    #[tokio::test]
    async fn open_dry_run_renders_resume_command() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("api");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_str().unwrap().to_string();
        fake_home(tmp.path(), &cwd_s);
        let (status, body) = call(
            app(tmp.path()),
            "POST",
            &format!("/api/agents/claude%3A{SID}/open?dry_run=true"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["action"], "would_launch");
        let command = body["command"].as_str().unwrap();
        assert!(command.starts_with(&format!("cd '{cwd_s}' && ")));
        assert!(command.ends_with(&format!(" && claude --resume {SID}")));
    }

    #[tokio::test]
    async fn open_rejects_missing_cwd_and_unknown_id() {
        let tmp = tempfile::tempdir().unwrap();
        fake_home(tmp.path(), "/nonexistent/api");
        let (status, _) = call(
            app(tmp.path()),
            "POST",
            &format!("/api/agents/claude:{SID}/open"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(app(tmp.path()), "POST", "/api/agents/claude:nope/open").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
