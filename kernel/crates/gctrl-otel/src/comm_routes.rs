//! macOS communication driver HTTP routes.
//!
//! Mounts `/api/comm/*` onto the kernel router. Backed by `gctrl-mac-comm`.
//!
//! On macOS, `POST /api/comm/focus` validates the request, applies a per-
//! `session_id` token-bucket rate limit, then dispatches to the iTerm2 /
//! Terminal.app adapter via `osascript`. On non-macOS, every focus call
//! returns 501 with a clear body — the route exists so the SPA capabilities
//! probe gets a structured "not supported" answer rather than a 404 that
//! could mean "daemon down" or "feature off."
//!
//! Remote-vs-local determination is delegated to the host-allowlist
//! middleware (`gctrl-cli::host_allowlist_middleware`) which sits in front
//! of the entire router. Any request that reaches this handler has a Host
//! header in {localhost, 127.0.0.1, ::1}, so we treat the request as
//! local-origin. The `host` field in the request body is purely
//! informational — the payload cannot bypass the middleware regardless of
//! what it claims. If/when the daemon ever binds a non-loopback interface,
//! the middleware boundary changes and this assumption needs to be
//! reconsidered (the FocusRequest already carries `origin_remote` so the
//! call site is the only thing that needs updating).

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gctrl_mac_comm::{
    capabilities, focus, rate_limit::RateLimiterConfig, validate, CommError, FocusRequest,
    RateLimiter,
};
use std::sync::OnceLock;

fn rate_limiter() -> &'static RateLimiter {
    static CACHED: OnceLock<RateLimiter> = OnceLock::new();
    CACHED.get_or_init(|| RateLimiter::new(RateLimiterConfig::default()))
}

fn map_err(e: CommError) -> (StatusCode, String) {
    let status = match &e {
        CommError::NotSupported => StatusCode::NOT_IMPLEMENTED,
        CommError::Validation { .. } => StatusCode::BAD_REQUEST,
        CommError::UnknownTarget(_) => StatusCode::BAD_REQUEST,
        CommError::SessionNotFound { .. } => StatusCode::NOT_FOUND,
        CommError::TargetNotRunning { .. } => StatusCode::SERVICE_UNAVAILABLE,
        CommError::AutomationDenied { .. } => StatusCode::FORBIDDEN,
        CommError::OsascriptTimeout { .. } => StatusCode::GATEWAY_TIMEOUT,
        CommError::OsascriptFailed { .. } => StatusCode::BAD_GATEWAY,
        CommError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
        CommError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, e.to_string())
}

async fn handle_focus(Json(mut req): Json<FocusRequest>) -> impl IntoResponse {
    // The `origin_remote` flag is overwritten HERE, never trusted from the
    // body. Today the host-allowlist middleware guarantees loopback-only
    // requests reach this handler (see module doc-comment); a non-loopback
    // bind would change this default.
    req.origin_remote = false;

    if let Err(e) = validate::focus_request(&req) {
        return map_err(e).into_response();
    }

    // Rate-limit per session_id. Requests without a session_id (e.g. Apple
    // Terminal indexed by window/tab) get a single shared bucket per
    // `(target, window, tab)` triple — same backpressure semantics with no
    // schema-required key.
    let bucket_key = req
        .session_id
        .clone()
        .unwrap_or_else(|| {
            format!(
                "{:?}:{}:{}",
                req.target,
                req.window_id.as_deref().unwrap_or("-"),
                req.tab_id.as_deref().unwrap_or("-"),
            )
        });
    if !rate_limiter().try_acquire(&bucket_key) {
        return map_err(CommError::RateLimited(bucket_key)).into_response();
    }

    match focus(&req).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

async fn handle_capabilities() -> impl IntoResponse {
    Json(capabilities())
}

/// Mount the comm driver routes.
///
/// Type parameter `S` matches the gcal_routes pattern — these routes carry no
/// router state of their own; they're stateless and use a process-wide
/// rate-limiter cell.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/comm/focus", post(handle_focus))
        .route("/api/comm/capabilities", get(handle_capabilities))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn make_router() -> Router {
        router::<()>()
    }

    fn post_focus(body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/comm/focus")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn capabilities_route_is_reachable() {
        let app = make_router();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/comm/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.get("os").is_some(), "capabilities must include `os`");
        assert!(
            json.get("terminals").is_some(),
            "capabilities must include `terminals`"
        );
    }

    #[tokio::test]
    async fn focus_rejects_unknown_target() {
        let app = make_router();
        let res = app
            .oneshot(post_focus(serde_json::json!({ "target": "unknown" })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn focus_rejects_invalid_session_id_for_iterm2() {
        let app = make_router();
        let res = app
            .oneshot(post_focus(serde_json::json!({
                "target": "iterm2",
                "session_id": "not-a-real-iterm-id"
            })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn focus_rejects_quote_injection_in_session_id() {
        let app = make_router();
        let evil = "w0t0p0:X\" & do shell script \"rm -rf /\"";
        let res = app
            .oneshot(post_focus(serde_json::json!({
                "target": "iterm2",
                "session_id": evil
            })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn focus_rejects_payload_origin_remote_spoof() {
        // Even if the payload claims `origin_remote: true`, the handler
        // overwrites it. Validation still runs; an otherwise-valid request
        // must reach the focus dispatcher (which on non-mac returns 501,
        // on mac would attempt iTerm2 and most likely 404).
        let app = make_router();
        let res = app
            .oneshot(post_focus(serde_json::json!({
                "target": "iterm2",
                "session_id": "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765",
                "origin_remote": true
            })))
            .await
            .unwrap();
        // The origin_remote field is `skip_serializing` on deserialize-only
        // surface AND overwritten in the handler; either way it does NOT
        // produce a "remote_session" short-circuit that would give a 200.
        assert_ne!(res.status(), StatusCode::OK);
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn focus_returns_501_on_non_macos() {
        let app = make_router();
        let res = app
            .oneshot(post_focus(serde_json::json!({
                "target": "iterm2",
                "session_id": "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765"
            })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
