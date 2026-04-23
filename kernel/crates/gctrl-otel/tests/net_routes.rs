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
use std::sync::{Arc, Mutex, OnceLock};
use tower::ServiceExt;

/// Serializes tests that mutate process env vars (otherwise they race in parallel
/// and clobber each other's CLOUDFLARE_* / *_API_KEY state).
fn env_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

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
async fn telegram_send_returns_503_without_token() {
    // Guard: isolate from any ambient TELEGRAM_BOT_TOKEN in the test env.
    // SAFETY: tests in this crate run single-threaded by default; no concurrent env mutation.
    let prev = std::env::var("TELEGRAM_BOT_TOKEN").ok();
    unsafe {
        std::env::remove_var("TELEGRAM_BOT_TOKEN");
    }
    let app = router_with(NetConfig::default());
    let (status, body) = post_json(
        &app,
        "/api/telegram/send",
        serde_json::json!({ "chat_id": "123", "text": "hi" }),
    )
    .await;
    if let Some(v) = prev {
        unsafe {
            std::env::set_var("TELEGRAM_BOT_TOKEN", v);
        }
    }
    assert_eq!(status, 503);
    assert!(body.contains("TELEGRAM_BOT_TOKEN"));
}

#[tokio::test]
async fn discord_send_rejects_non_webhook_url() {
    let app = router_with(NetConfig::default());
    let (status, body) = post_json(
        &app,
        "/api/discord/send",
        serde_json::json!({ "webhook_url": "https://example.com/evil", "content": "hi" }),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body.contains("discord.com/api/webhooks"));
}

#[tokio::test]
async fn llm_messages_fails_closed_without_gateway_config() {
    let _guard = env_mutex().lock().unwrap();
    // Guard: isolate from any ambient CF/Anthropic creds in the test env.
    let prev_acct = std::env::var("CLOUDFLARE_ACCOUNT_ID").ok();
    let prev_gw = std::env::var("CLOUDFLARE_AI_GATEWAY_ID").ok();
    let prev_gw_tok = std::env::var("CLOUDFLARE_AI_GATEWAY_TOKEN").ok();
    let prev_anth = std::env::var("ANTHROPIC_API_KEY").ok();
    unsafe {
        std::env::remove_var("CLOUDFLARE_ACCOUNT_ID");
        std::env::remove_var("CLOUDFLARE_AI_GATEWAY_ID");
        std::env::remove_var("CLOUDFLARE_AI_GATEWAY_TOKEN");
        std::env::remove_var("ANTHROPIC_API_KEY");
    }
    let app = router_with(NetConfig::default());
    let probe_body = serde_json::json!({
        "model": "claude-opus-4-7",
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "hi" }],
    });

    // 1. Missing CLOUDFLARE_ACCOUNT_ID → 503
    let (status, body) = post_json(&app, "/api/llm/messages", probe_body.clone()).await;
    assert_eq!(status, 503);
    assert!(body.contains("CLOUDFLARE_ACCOUNT_ID"));

    // 2. Account id set but missing gateway id → 503
    unsafe { std::env::set_var("CLOUDFLARE_ACCOUNT_ID", "acct-test") };
    let (status, body) = post_json(&app, "/api/llm/messages", probe_body.clone()).await;
    assert_eq!(status, 503);
    assert!(body.contains("CLOUDFLARE_AI_GATEWAY_ID"));

    // 3. Account + gateway set but no auth → 503
    unsafe { std::env::set_var("CLOUDFLARE_AI_GATEWAY_ID", "gw-test") };
    let (status, body) = post_json(&app, "/api/llm/messages", probe_body).await;
    assert_eq!(status, 503);
    assert!(
        body.contains("ANTHROPIC_API_KEY") && body.contains("CLOUDFLARE_AI_GATEWAY_TOKEN"),
        "body was: {body}"
    );

    // Restore ambient env.
    unsafe {
        std::env::remove_var("CLOUDFLARE_ACCOUNT_ID");
        std::env::remove_var("CLOUDFLARE_AI_GATEWAY_ID");
        if let Some(v) = prev_acct {
            std::env::set_var("CLOUDFLARE_ACCOUNT_ID", v);
        }
        if let Some(v) = prev_gw {
            std::env::set_var("CLOUDFLARE_AI_GATEWAY_ID", v);
        }
        if let Some(v) = prev_gw_tok {
            std::env::set_var("CLOUDFLARE_AI_GATEWAY_TOKEN", v);
        }
        if let Some(v) = prev_anth {
            std::env::set_var("ANTHROPIC_API_KEY", v);
        }
    }
}

#[tokio::test]
async fn llm_completions_fails_closed_without_gateway_config() {
    let _guard = env_mutex().lock().unwrap();
    // Isolate from any ambient CF creds in the test env.
    let prev_acct = std::env::var("CLOUDFLARE_ACCOUNT_ID").ok();
    let prev_gw = std::env::var("CLOUDFLARE_AI_GATEWAY_ID").ok();
    let prev_cf_tok = std::env::var("CF_API_TOKEN").ok();
    unsafe {
        std::env::remove_var("CLOUDFLARE_ACCOUNT_ID");
        std::env::remove_var("CLOUDFLARE_AI_GATEWAY_ID");
        std::env::remove_var("CF_API_TOKEN");
    }
    let app = router_with(NetConfig::default());
    let probe_body = serde_json::json!({
        "model": "@cf/google/gemma-4-26b-a4b-it",
        "messages": [{ "role": "user", "content": "hi" }],
    });

    // 1. Missing CLOUDFLARE_ACCOUNT_ID → 503
    let (status, body) = post_json(&app, "/api/llm/completions", probe_body.clone()).await;
    assert_eq!(status, 503);
    assert!(body.contains("CLOUDFLARE_ACCOUNT_ID"));

    // 2. Account id set but missing gateway id → 503
    unsafe { std::env::set_var("CLOUDFLARE_ACCOUNT_ID", "acct-test") };
    let (status, body) = post_json(&app, "/api/llm/completions", probe_body.clone()).await;
    assert_eq!(status, 503);
    assert!(body.contains("CLOUDFLARE_AI_GATEWAY_ID"));

    // 3. Account + gateway set but no CF_API_TOKEN → 503
    unsafe { std::env::set_var("CLOUDFLARE_AI_GATEWAY_ID", "gw-test") };
    let (status, body) = post_json(&app, "/api/llm/completions", probe_body).await;
    assert_eq!(status, 503);
    assert!(body.contains("CF_API_TOKEN"), "body was: {body}");

    // Restore ambient env.
    unsafe {
        std::env::remove_var("CLOUDFLARE_ACCOUNT_ID");
        std::env::remove_var("CLOUDFLARE_AI_GATEWAY_ID");
        if let Some(v) = prev_acct {
            std::env::set_var("CLOUDFLARE_ACCOUNT_ID", v);
        }
        if let Some(v) = prev_gw {
            std::env::set_var("CLOUDFLARE_AI_GATEWAY_ID", v);
        }
        if let Some(v) = prev_cf_tok {
            std::env::set_var("CF_API_TOKEN", v);
        }
    }
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
