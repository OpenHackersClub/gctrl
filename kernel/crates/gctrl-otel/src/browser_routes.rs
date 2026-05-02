//! driver-browser HTTP routes (CDP attach layer).
//!
//! Mounts `/api/browser/*` onto the kernel router. PR1 surfaces the route
//! shape with stub responses so clients can be wired against the contract
//! before the Chromium pool is implemented in PR2:
//!
//! - `GET  /api/browser/health`       — implemented (real config + active count)
//! - `GET  /api/browser/sessions`     — `[]` (pool is empty)
//! - `POST /api/browser/sessions`     — `501 Not Implemented` (pool stub returns `Launch`)
//! - `DELETE /api/browser/sessions/:id` — `404 Not Found`
//! - `GET  /api/browser/sessions/:id` — `404 Not Found`
//! - `WS   /api/browser/sessions/:id/cdp` — `501 Not Implemented`
//!
//! Recorder routes (`/api/browser/sessions/:id/{network,console,metrics,report}`)
//! are not mounted here — they ship with `gctrl-recorder` in PR3.
//!
//! Spec: `vault/specs/implementation/kernel/driver-browser.md`.

use std::sync::Arc;

use axum::{
    extract::Path,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use gctrl_browser::{BrowserConfig, BrowserError, Pool, SessionId, SessionOptions};
use serde::Serialize;
use serde_json::json;
use tokio::sync::OnceCell;

#[derive(Clone)]
struct BrowserState {
    pool: Arc<Pool>,
}

static STATE: OnceCell<BrowserState> = OnceCell::const_new();

async fn state() -> BrowserState {
    STATE
        .get_or_init(|| async {
            let cfg = Arc::new(BrowserConfig::default().with_env_overrides());
            BrowserState {
                pool: Arc::new(Pool::new(cfg)),
            }
        })
        .await
        .clone()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    /// `null` until PR2 wires Chromium launch.
    chromium_version: Option<String>,
    active_sessions: usize,
    pool_max: u32,
    contexts_per_chromium_max: u32,
    recycle_idle_seconds: u64,
    recycle_max_age_seconds: u64,
}

async fn health() -> impl IntoResponse {
    let st = state().await;
    let cfg = st.pool.config();
    let body = HealthResponse {
        chromium_version: None,
        active_sessions: st.pool.active_count().await,
        pool_max: cfg.pool_max,
        contexts_per_chromium_max: cfg.contexts_per_chromium_max,
        recycle_idle_seconds: cfg.recycle_idle_seconds,
        recycle_max_age_seconds: cfg.recycle_max_age_seconds,
    };
    Json(body)
}

async fn list_sessions() -> impl IntoResponse {
    let st = state().await;
    Json(st.pool.list().await)
}

async fn create_session(Json(opts): Json<SessionOptions>) -> impl IntoResponse {
    let st = state().await;
    match st.pool.acquire(opts).await {
        Ok(info) => (StatusCode::CREATED, Json(serde_json::to_value(info).unwrap()))
            .into_response(),
        Err(e) => err_response(e).into_response(),
    }
}

async fn get_session(Path(id): Path<String>) -> impl IntoResponse {
    let st = state().await;
    let sid = SessionId::from(id);
    match st.pool.get(&sid).await {
        Some(info) => Json(info).into_response(),
        None => err_response(BrowserError::SessionNotFound(sid)).into_response(),
    }
}

async fn delete_session(Path(id): Path<String>) -> impl IntoResponse {
    let st = state().await;
    let sid = SessionId::from(id);
    match st.pool.release(&sid).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_response(e).into_response(),
    }
}

async fn cdp_attach_stub(Path(_id): Path<String>) -> impl IntoResponse {
    // PR2 will replace this with a WebSocket upgrade handler that validates
    // the bearer token and proxies CDP frames bidirectionally between the
    // client and the per-session Chromium endpoint.
    err_response(BrowserError::Cdp(
        "cdp websocket attach is not implemented in PR1 — lands in PR2".into(),
    ))
}

fn err_response(e: BrowserError) -> (StatusCode, Json<serde_json::Value>) {
    let status = status_for(&e);
    let body = Json(json!({
        "error": e.kind(),
        "message": e.to_string(),
    }));
    (status, body)
}

fn status_for(e: &BrowserError) -> StatusCode {
    match e {
        BrowserError::PoolExhausted { .. } => StatusCode::TOO_MANY_REQUESTS,
        BrowserError::SessionNotFound(_) => StatusCode::NOT_FOUND,
        BrowserError::SessionExpired(_) => StatusCode::GONE,
        BrowserError::InvalidToken(_) => StatusCode::UNAUTHORIZED,
        BrowserError::RecordingDisabled => StatusCode::CONFLICT,
        BrowserError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
        // PR1 stub paths land here:
        BrowserError::Launch(_) | BrowserError::Cdp(_) => StatusCode::NOT_IMPLEMENTED,
    }
}

/// Build the `/api/browser/*` router. State is held in an internal
/// `OnceCell` so the same `Pool` is reused across requests within the
/// daemon. The router is parameterized over an arbitrary state type `S`
/// so it composes with `Router<()>` in `build_router` and any other
/// state type used by tests.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/browser/health", get(health))
        .route(
            "/api/browser/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/api/browser/sessions/{id}",
            get(get_session).delete(delete_session),
        )
        .route("/api/browser/sessions/{id}/cdp", get(cdp_attach_stub))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        router::<()>().with_state(())
    }

    #[tokio::test]
    async fn health_reports_pool_config() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["chromiumVersion"].is_null());
        assert_eq!(v["activeSessions"], 0);
        assert_eq!(v["poolMax"], 4);
    }

    #[tokio::test]
    async fn list_sessions_empty_in_pr1() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.is_array());
        assert_eq!(v.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn create_session_returns_501_in_pr1() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["error"], "launch_failed");
    }

    #[tokio::test]
    async fn create_session_validates_ttl() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"ttlSeconds": 9999}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["error"], "invalid_request");
    }

    #[tokio::test]
    async fn get_unknown_session_404s() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_unknown_session_404s() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/browser/sessions/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cdp_attach_stub_returns_501() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions/abc/cdp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
