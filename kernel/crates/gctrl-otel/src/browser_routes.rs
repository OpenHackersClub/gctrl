//! driver-browser HTTP routes (CDP attach layer).
//!
//! Mounts `/api/browser/*` onto the kernel router:
//!
//! - `GET    /api/browser/health`               — pool config + chromium version
//! - `GET    /api/browser/sessions`             — list active sessions
//! - `POST   /api/browser/sessions`             — acquire a session (real)
//! - `GET    /api/browser/sessions/:id`         — get one session
//! - `DELETE /api/browser/sessions/:id`         — release immediately
//! - `WS     /api/browser/sessions/:id/cdp`     — token-gated CDP proxy
//!
//! Recorder routes (`/network`, `/console`, `/metrics`, `/report`) live in
//! `recorder_routes.rs` (PR3). They consume the same `Pool` via subscribe.
//!
//! Spec: `vault/specs/implementation/kernel/driver-browser.md`.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gctrl_browser::{
    run_proxy, BrowserConfig, BrowserError, MockLauncher, Pool, RealLauncher, SessionId,
    SessionOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Mutex, OnceLock};
use tokio::sync::OnceCell;

#[derive(Clone)]
pub(crate) struct BrowserState {
    pub(crate) pool: Arc<Pool>,
}

static STATE: OnceCell<BrowserState> = OnceCell::const_new();

/// Test override — replaceable so different tests can install fresh
/// pools. Production reads `STATE` (the global `OnceCell`) and ignores
/// this slot entirely.
static TEST_OVERRIDE: OnceLock<Mutex<Option<BrowserState>>> = OnceLock::new();

fn test_override() -> &'static Mutex<Option<BrowserState>> {
    TEST_OVERRIDE.get_or_init(|| Mutex::new(None))
}

pub(crate) async fn state() -> BrowserState {
    if let Some(s) = test_override().lock().unwrap().clone() {
        return s;
    }
    STATE
        .get_or_init(|| async {
            let cfg = Arc::new(BrowserConfig::default().with_env_overrides());
            // Default to a real launcher; misconfiguration / missing
            // Chromium is reported lazily on first acquire.
            let launcher: Arc<dyn gctrl_browser::Launcher> = match RealLauncher::new(
                cfg.chromium_path.clone(),
                cfg.headed_default,
            ) {
                Ok(l) => Arc::new(l),
                Err(e) => {
                    tracing::warn!(error=%e, "real chromium launcher unavailable; using mock");
                    Arc::new(MockLauncher::new("ws://127.0.0.1:0/disabled"))
                }
            };
            let pool = Arc::new(Pool::new(
                cfg,
                launcher,
                "ws://127.0.0.1:4318".into(),
            ));
            // Spawn the recycle background task. It runs until the daemon
            // exits; OnceCell ensures only one is started.
            let pool_for_loop = Arc::clone(&pool);
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let report = pool_for_loop.sweep().await;
                    if report.expired_sessions + report.drained + report.killed > 0 {
                        tracing::info!(
                            expired = report.expired_sessions,
                            drained = report.drained,
                            killed = report.killed,
                            "browser pool sweep"
                        );
                    }
                }
            });
            BrowserState { pool }
        })
        .await
        .clone()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    chromium_version: Option<String>,
    active_sessions: usize,
    chromium_count: usize,
    pool_max: u32,
    contexts_per_chromium_max: u32,
    recycle_idle_seconds: u64,
    recycle_max_age_seconds: u64,
}

async fn health() -> impl IntoResponse {
    let st = state().await;
    let cfg = st.pool.config();
    let body = HealthResponse {
        chromium_version: st.pool.browser_version().await,
        active_sessions: st.pool.active_count().await,
        chromium_count: st.pool.chromium_count().await,
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
        Ok(info) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(info).unwrap()),
        )
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

#[derive(Debug, Deserialize, Default)]
struct CdpQuery {
    token: Option<String>,
}

async fn cdp_attach(
    Path(id): Path<String>,
    Query(q): Query<CdpQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    let st = state().await;
    let sid = SessionId::from(id);

    // Token can come either as `?token=...` or `Authorization: Bearer ...`.
    let token = q
        .token
        .or_else(|| {
            headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    match st.pool.attach(&sid, &token).await {
        Ok((upstream_url, tap)) => ws
            .on_upgrade(move |socket: WebSocket| async move {
                if let Err(e) = run_proxy(socket, upstream_url, tap).await {
                    tracing::warn!(error=%e, "cdp proxy ended with error");
                }
            })
            .into_response(),
        Err(e) => err_response(e).into_response(),
    }
}

/// `POST /api/browser/replays`
///
/// Create a fresh session that replays a previously recorded one. The
/// recorder is currently in-memory only, so this endpoint provisions a
/// new session and stamps the source session id into a tag for
/// follow-up by clients. Once recorder persistence to DuckDB lands, the
/// new session will have its frames re-driven from the recorded trace.
///
/// Body:
/// ```json
/// { "sessionId": "01HV…", "ttlSeconds": 600 }
/// ```
async fn create_replay(Json(body): Json<ReplayRequest>) -> impl IntoResponse {
    let st = state().await;
    // Source must exist (or have existed) for the replay to be meaningful.
    // We don't yet persist released sessions, so missing source → 404 even
    // though the API is otherwise live.
    let src_exists = st
        .pool
        .get(&SessionId::from(body.session_id.clone()))
        .await
        .is_some();
    if !src_exists {
        return err_response(BrowserError::SessionNotFound(SessionId::from(
            body.session_id,
        )))
        .into_response();
    }
    let opts = SessionOptions {
        ttl_seconds: body.ttl_seconds.unwrap_or(600),
        ..Default::default()
    };
    match st.pool.acquire(opts).await {
        Ok(info) => (
            StatusCode::CREATED,
            Json(json!({
                "session": serde_json::to_value(info).unwrap(),
                "sourceSessionId": body.session_id,
                "replay": "scaffolded — frame re-drive lands once recorder persistence does",
            })),
        )
            .into_response(),
        Err(e) => err_response(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayRequest {
    session_id: String,
    ttl_seconds: Option<u32>,
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
        BrowserError::Launch(_) | BrowserError::Cdp(_) => StatusCode::BAD_GATEWAY,
    }
}

/// Build the `/api/browser/*` router. State is held in an internal
/// `OnceCell` so the same `Pool` is reused across requests within the
/// daemon. Tests inject a mock pool via `install_test_state`.
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
        .route("/api/browser/sessions/{id}/cdp", get(cdp_attach))
        .route("/api/browser/replays", post(create_replay))
}

/// Test helper: install a state with a mock launcher so route tests don't
/// need Chromium. Replaces any prior override so each test starts fresh.
#[doc(hidden)]
pub fn install_test_state(pool: Arc<Pool>) {
    *test_override().lock().unwrap() = Some(BrowserState { pool });
}

/// Test helper: clear the override so subsequent calls fall through to
/// the production `STATE` cell. Routes-tests should not call this; it's
/// for higher-level integration suites that need a clean slate.
#[doc(hidden)]
pub fn clear_test_state() {
    *test_override().lock().unwrap() = None;
}

/// Cross-module test lock — both browser_routes::tests and
/// recorder_routes::tests install/replace the global pool override, so
/// they need to serialize. Held for the duration of each test.
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use gctrl_browser::MockLauncher;
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn install_mock_pool() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap();
        let _ = install_mock_pool_inner();
        g
    }

    fn install_mock_pool_inner() {
        let cfg = Arc::new(BrowserConfig::default());
        let launcher = Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake"));
        let pool = Arc::new(Pool::new(cfg, launcher, "ws://127.0.0.1:4318".into()));
        install_test_state(pool);
    }

    fn app() -> Router {
        router::<()>().with_state(())
    }

    #[tokio::test]
    async fn health_reports_pool_config() {
        let _g = install_mock_pool();
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
        assert_eq!(v["poolMax"], 4);
        assert_eq!(v["contextsPerChromiumMax"], 8);
    }

    #[tokio::test]
    async fn list_sessions_starts_empty() {
        let _g = install_mock_pool();
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
    }

    #[tokio::test]
    async fn create_session_validates_ttl() {
        let _g = install_mock_pool();
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
        let _g = install_mock_pool();
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
        let _g = install_mock_pool();
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
    async fn create_replay_404s_for_unknown_source() {
        let _g = install_mock_pool();
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/replays")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sessionId": "missing"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_replay_returns_new_session_when_source_exists() {
        let _g = TEST_LOCK.lock().unwrap();
        // Set up a pool, acquire a source session.
        let cfg = Arc::new(BrowserConfig::default());
        let launcher = Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake"));
        let pool = Arc::new(Pool::new(cfg, launcher, "ws://127.0.0.1:4318".into()));
        install_test_state(Arc::clone(&pool));
        let src = pool
            .acquire(gctrl_browser::SessionOptions::default())
            .await
            .unwrap();
        let body = format!(r#"{{"sessionId": "{}"}}"#, src.id);
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/replays")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["sourceSessionId"], src.id.to_string());
        assert!(v["session"]["id"].is_string());
    }

    #[tokio::test]
    async fn cdp_attach_without_upgrade_headers_400s() {
        // axum's `WebSocketUpgrade` extractor rejects non-upgrade requests
        // before our handler runs, so a plain GET (no Upgrade/Connection
        // headers) yields 400. End-to-end token / session-lookup behavior
        // is exercised by the pool's `attach_validates_token` unit test;
        // a true WS handshake test belongs in an integration suite.
        let _g = install_mock_pool();
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions/does-not-exist/cdp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
