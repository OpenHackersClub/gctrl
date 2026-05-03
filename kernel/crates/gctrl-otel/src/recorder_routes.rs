//! driver-browser recorder routes (L2).
//!
//! Per-session structured CDP captures, exposed as a few JSON endpoints
//! that mirror the in-app `CDPObserver` shape today's board acceptance
//! tests use:
//!
//! - `GET /api/browser/sessions/:id/network`  → `CapturedRequest[]`
//! - `GET /api/browser/sessions/:id/console`  → `ConsoleEntry[]`
//! - `GET /api/browser/sessions/:id/metrics`  → `MetricSample[]`
//! - `GET /api/browser/sessions/:id/report`   → `ObservabilityReport`
//!
//! Sinks live in a process-global registry keyed by `SessionId`. The
//! pool's `subscribe` API gives us per-session frame streams; we pump
//! each into a `CaptureSink`. The DDL in `gctrl-storage::schema` is
//! provisioned but persistence to DuckDB is deferred until a future PR
//! (in-memory snapshots match what the board acceptance harness needs
//! today; durable replay benefits from the kernel-side flush job).
//!
//! Spec: `vault/specs/implementation/kernel/driver-browser.md` §3 + §4.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::Path, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use gctrl_browser::SessionId;
use gctrl_recorder::{CaptureSink, ObservabilityReport};
use serde_json::json;
use tokio::sync::{Mutex, OnceCell};

use crate::browser_routes::state as browser_state;

#[derive(Default)]
struct Registry {
    sinks: HashMap<String, Arc<CaptureSink>>,
    handles: HashMap<String, tokio::task::JoinHandle<()>>,
}

static REGISTRY: OnceCell<Arc<Mutex<Registry>>> = OnceCell::const_new();

async fn registry() -> Arc<Mutex<Registry>> {
    REGISTRY
        .get_or_init(|| async { Arc::new(Mutex::new(Registry::default())) })
        .await
        .clone()
}

/// Attach a sink for the given session. If one already exists it is
/// returned as-is; otherwise a fresh sink is wired to a new pump task
/// reading the pool's per-session frame broadcast.
async fn ensure_sink(id: &SessionId, max_bytes: u64) -> Option<Arc<CaptureSink>> {
    let pool = browser_state().await.pool;
    let key = id.to_string();
    let reg = registry().await;
    let mut reg = reg.lock().await;
    if let Some(s) = reg.sinks.get(&key) {
        return Some(Arc::clone(s));
    }
    let rx = pool.subscribe(id).await?;
    let sink = Arc::new(CaptureSink::new(max_bytes));
    let handle = CaptureSink::pump(Arc::clone(&sink), rx);
    reg.sinks.insert(key.clone(), Arc::clone(&sink));
    reg.handles.insert(key, handle);
    Some(sink)
}

async fn list_network(Path(id): Path<String>) -> impl IntoResponse {
    let sid = SessionId::from(id);
    match get_or_install(&sid).await {
        Some(s) => Json(s.requests().await).into_response(),
        None => not_found(),
    }
}

async fn list_console(Path(id): Path<String>) -> impl IntoResponse {
    let sid = SessionId::from(id);
    match get_or_install(&sid).await {
        Some(s) => Json(s.console().await).into_response(),
        None => not_found(),
    }
}

async fn list_metrics(Path(id): Path<String>) -> impl IntoResponse {
    let sid = SessionId::from(id);
    match get_or_install(&sid).await {
        Some(s) => Json(s.metrics().await).into_response(),
        None => not_found(),
    }
}

async fn report(Path(id): Path<String>) -> impl IntoResponse {
    let sid = SessionId::from(id);
    let Some(sink) = get_or_install(&sid).await else {
        return not_found();
    };
    let stats = sink.stats().await;
    let r = ObservabilityReport::build(
        sid.to_string(),
        sink.requests().await,
        sink.console().await,
        sink.metrics().await,
        stats.recorded_bytes,
        stats.dropped_frames,
    );
    Json(r).into_response()
}

/// Resolve the sink for an active session. If the recorder hasn't yet
/// attached for this session, attach now using the session's recording
/// cap (so the first observation request bootstraps the sink lazily).
async fn get_or_install(id: &SessionId) -> Option<Arc<CaptureSink>> {
    let pool = browser_state().await.pool;
    let info = pool.get(id).await?;
    let max_bytes = info.recording.max_bytes.max(1);
    ensure_sink(id, max_bytes).await
}

fn not_found() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "session_not_found" })),
    )
        .into_response()
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/browser/sessions/{id}/network", get(list_network))
        .route("/api/browser/sessions/{id}/console", get(list_console))
        .route("/api/browser/sessions/{id}/metrics", get(list_metrics))
        .route("/api/browser/sessions/{id}/report", get(report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_routes::install_test_state;
    use axum::body::Body;
    use gctrl_browser::{BrowserConfig, MockLauncher, Pool, SessionOptions};
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::browser_routes::TEST_LOCK;

    async fn install_pool_and_create_session() -> String {
        let cfg = Arc::new(BrowserConfig::default());
        let launcher = Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake"));
        let pool = Arc::new(Pool::new(cfg, launcher, "ws://127.0.0.1:4318".into()));
        install_test_state(Arc::clone(&pool));
        let info = pool.acquire(SessionOptions::default()).await.unwrap();
        info.id.to_string()
    }

    fn app() -> Router {
        router::<()>().with_state(())
    }

    #[tokio::test]
    async fn report_returns_empty_for_fresh_session() {
        let _g = TEST_LOCK.lock().unwrap();
        let id = install_pool_and_create_session().await;
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/browser/sessions/{id}/report"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["sessionId"], id);
        assert!(v["requests"].as_array().unwrap().is_empty());
        assert!(v["console"].as_array().unwrap().is_empty());
        assert!(v["metrics"].as_array().unwrap().is_empty());
        assert_eq!(v["stats"]["requestCount"], 0);
    }

    #[tokio::test]
    async fn report_404s_for_unknown_session() {
        let _g = TEST_LOCK.lock().unwrap();
        // Install a fresh empty pool so no sessions exist.
        let cfg = Arc::new(BrowserConfig::default());
        let launcher = Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake"));
        let pool = Arc::new(Pool::new(cfg, launcher, "ws://127.0.0.1:4318".into()));
        install_test_state(pool);
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions/bogus/report")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
