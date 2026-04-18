//! Integration tests for /api/search/* and /api/net/* routes.
//!
//! These tests verify fail-closed behaviour when credentials are not configured.
//! Live smoke tests against Brave and Cloudflare run separately and require
//! real API keys (see PR #32).

use axum::body::Body;
use gctrl_core::NetConfig;
use gctrl_otel::create_router_full;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn router_with(net_config: NetConfig) -> axum::Router {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    create_router_full(store, sqlite, None, Arc::new(net_config))
}

async fn post_json(app: &axum::Router, uri: &str, body: serde_json::Value) -> (u16, String) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn search_web_returns_503_without_api_key() {
    let app = router_with(NetConfig::default());
    let (status, body) = post_json(&app, "/api/search/web", serde_json::json!({ "q": "x" })).await;
    assert_eq!(status, 503);
    assert!(body.contains("BRAVE_SEARCH_API_KEY"));
}

#[tokio::test]
async fn search_news_returns_503_without_api_key() {
    let app = router_with(NetConfig::default());
    let (status, body) =
        post_json(&app, "/api/search/news", serde_json::json!({ "q": "x" })).await;
    assert_eq!(status, 503);
    assert!(body.contains("BRAVE_SEARCH_API_KEY"));
}

#[tokio::test]
async fn search_images_returns_503_without_api_key() {
    let app = router_with(NetConfig::default());
    let (status, body) =
        post_json(&app, "/api/search/images", serde_json::json!({ "q": "x" })).await;
    assert_eq!(status, 503);
    assert!(body.contains("BRAVE_SEARCH_API_KEY"));
}

#[tokio::test]
async fn net_render_returns_503_without_cf_account_id() {
    let app = router_with(NetConfig::default());
    let (status, body) = post_json(
        &app,
        "/api/net/render",
        serde_json::json!({ "url": "https://example.com" }),
    )
    .await;
    assert_eq!(status, 503);
    assert!(body.contains("CF_ACCOUNT_ID"));
}

#[tokio::test]
async fn net_render_returns_503_without_cf_api_token() {
    let cfg = NetConfig {
        cf_account_id: Some("test-account".into()),
        ..Default::default()
    };
    let app = router_with(cfg);
    let (status, body) = post_json(
        &app,
        "/api/net/render",
        serde_json::json!({ "url": "https://example.com" }),
    )
    .await;
    assert_eq!(status, 503);
    assert!(body.contains("CF_API_TOKEN"));
}

#[tokio::test]
async fn net_scrape_returns_503_without_cf_creds() {
    let app = router_with(NetConfig::default());
    let (status, _body) = post_json(
        &app,
        "/api/net/scrape",
        serde_json::json!({
            "url": "https://example.com",
            "elements": [{ "selector": "h1" }]
        }),
    )
    .await;
    assert_eq!(status, 503);
}

#[tokio::test]
async fn net_screenshot_returns_503_without_cf_creds() {
    let app = router_with(NetConfig::default());
    let (status, _body) = post_json(
        &app,
        "/api/net/screenshot",
        serde_json::json!({ "url": "https://example.com" }),
    )
    .await;
    assert_eq!(status, 503);
}

#[tokio::test]
async fn net_fetch_static_works_without_cf_creds() {
    // Static mode should never need CF creds — just verifies routing accepts
    // the request. (We don't assert on a specific status because example.com
    // may not be reachable in the CI sandbox; we only check it's not 503.)
    let app = router_with(NetConfig::default());
    let (status, _body) = post_json(
        &app,
        "/api/net/fetch",
        serde_json::json!({
            "url": "https://example.com",
            "render": { "kind": "static" }
        }),
    )
    .await;
    // Either success or upstream failure — not a config-gated 503.
    assert_ne!(status, 503, "static fetch should not be gated on CF creds");
}

#[tokio::test]
async fn net_fetch_browser_returns_503_without_cf_creds() {
    let app = router_with(NetConfig::default());
    let (status, body) = post_json(
        &app,
        "/api/net/fetch",
        serde_json::json!({
            "url": "https://example.com",
            "render": { "kind": "browser" }
        }),
    )
    .await;
    assert_eq!(status, 503);
    assert!(body.contains("cloudflare-browser"), "body was: {body}");
}
