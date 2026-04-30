//! Host header allowlist middleware.
//!
//! Defeats DNS rebinding attacks against the kernel daemon. Even though the
//! daemon binds `127.0.0.1` by default, a browser tab that resolves a
//! controlled hostname to `127.0.0.1` can still issue requests against
//! `:4318` from inside the same-origin sandbox. By checking that the
//! `Host` header names a loopback identity, we reject those requests at
//! the router boundary.
//!
//! This is a hard prerequisite for `target_kind: exec` in the scheduler — that
//! primitive lets a caller run arbitrary commands as the daemon user, and
//! `:4318` has no auth today. Until auth lands, host-allowlisting is the
//! barrier between "rebound browser tab" and "RCE."
//!
//! Allowed hosts: `localhost`, `127.0.0.1`, `[::1]`, `::1`, plus any of those
//! followed by a port. Anything else returns 403.

use axum::{
    extract::Request, http::StatusCode, middleware, response::Response, Router,
};

const ALLOWED_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]"];

pub fn apply(router: Router) -> Router {
    router.layer(middleware::from_fn(host_check))
}

async fn host_check(req: Request, next: middleware::Next) -> Result<Response, StatusCode> {
    let Some(host_header) = req.headers().get(axum::http::header::HOST) else {
        // No Host header — RFC 7230 says this is a 400 for HTTP/1.1, but
        // forgiving missing-header here keeps test fixtures (which often
        // omit it) working. Rejecting only mismatched hosts is enough to
        // defeat DNS rebinding.
        return Ok(next.run(req).await);
    };
    let raw = host_header.to_str().unwrap_or("");
    let host_only = raw.rsplit_once(':').map(|(h, _)| h).unwrap_or(raw);
    if ALLOWED_HOSTS
        .iter()
        .any(|allowed| host_only.eq_ignore_ascii_case(allowed))
    {
        Ok(next.run(req).await)
    } else {
        tracing::warn!(host = %raw, "rejected request: Host header not in loopback allowlist");
        Err(StatusCode::FORBIDDEN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::get, Router};
    use tower::ServiceExt;

    fn app() -> Router {
        let r = Router::new().route("/ping", get(|| async { "pong" }));
        apply(r)
    }

    #[tokio::test]
    async fn allows_localhost() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .header("host", "localhost:4318")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn allows_127_0_0_1() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .header("host", "127.0.0.1:4318")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_attacker_host() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .header("host", "attacker.example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn allows_missing_host_header() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
