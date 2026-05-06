//! CORS layer for the kernel HTTP API.
//!
//! The Electron renderer (gctrl-desktop) loads its bundled SPA from `file://`
//! and fetches `http://127.0.0.1:4318/api/...`. That is a cross-origin request,
//! and the SPA's `request()` helper sends `Content-Type: application/json` —
//! which is *not* a CORS-safelisted Content-Type, so every call (including
//! plain GETs) triggers a CORS preflight. Without an OPTIONS handler the
//! preflight returns 405 and the browser surfaces `TypeError: Failed to fetch`.
//!
//! `host_allowlist_middleware` already blocks DNS-rebinding, so the CORS
//! policy here is intentionally permissive for loopback / file origins:
//! the *attack* surface is gated on Host, not Origin.
//!
//! Allowed origins:
//!   - `null` (file:// renders, as sent by Chromium)
//!   - `file://...`
//!   - `http://localhost[:port]` and `https://localhost[:port]`
//!   - `http://127.0.0.1[:port]`, `http://[::1][:port]` and https equivalents
//!   - `app://...` (reserved for a future Electron custom protocol)
//!
//! Anything else falls through unhandled, the layer omits the
//! `Access-Control-Allow-Origin` header, and the browser blocks the response.

use std::time::Duration;

use axum::{
    http::{header, HeaderName, HeaderValue, Method},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub fn apply(router: Router) -> Router {
    router.layer(layer())
}

fn layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| is_allowed_origin(origin)))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            HeaderName::from_static("x-session-id"),
            HeaderName::from_static("x-service-name"),
        ])
        .max_age(Duration::from_secs(600))
}

fn is_allowed_origin(origin: &HeaderValue) -> bool {
    let Ok(s) = origin.to_str() else { return false };
    if s == "null" || s.starts_with("file://") || s.starts_with("app://") {
        return true;
    }
    is_loopback_http(s)
}

fn is_loopback_http(origin: &str) -> bool {
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.rsplit_once(':').map(|(h, _)| h).unwrap_or(rest);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(s: &str) -> HeaderValue {
        HeaderValue::from_str(s).unwrap()
    }

    #[test]
    fn allows_file_protocol() {
        assert!(is_allowed_origin(&header("null")));
        assert!(is_allowed_origin(&header("file://")));
        assert!(is_allowed_origin(&header("file:///Users/me/index.html")));
    }

    #[test]
    fn allows_app_protocol() {
        assert!(is_allowed_origin(&header("app://gctrl-board.local")));
    }

    #[test]
    fn allows_loopback_http() {
        assert!(is_allowed_origin(&header("http://localhost")));
        assert!(is_allowed_origin(&header("http://localhost:4200")));
        assert!(is_allowed_origin(&header("http://127.0.0.1:4318")));
        assert!(is_allowed_origin(&header("https://localhost:5173")));
        assert!(is_allowed_origin(&header("http://[::1]:4318")));
    }

    #[test]
    fn rejects_public_origins() {
        assert!(!is_allowed_origin(&header("http://attacker.example.com")));
        assert!(!is_allowed_origin(&header("https://example.com:4318")));
        assert!(!is_allowed_origin(&header("http://127.0.0.1.evil.com")));
    }
}
