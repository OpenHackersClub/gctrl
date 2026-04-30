//! Integration tests for `/api/uber/briefs` index routes.
//!
//! Vault file is the source of truth — this index is `(date, kind)`-keyed
//! metadata that lets the dashboard / shell list briefs without re-reading
//! every markdown file in the vault.

use axum::body::Body;
use gctrl_core::NetConfig;
use gctrl_otel::create_router_full;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn router() -> axum::Router {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    create_router_full(store, sqlite, None, Arc::new(NetConfig::default()))
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

async fn get_url(app: &axum::Router, uri: &str) -> (u16, String) {
    let req = Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn brief_body(date: &str, vault_path: &str) -> serde_json::Value {
    serde_json::json!({
        "date": date,
        "kind": "daily",
        "vault_path": vault_path,
        "content_hash": "0".repeat(64),
        "profile_name": "test-investor",
        "generator": "uebermensch",
        "model": "google/gemma-4-31b",
        "prompt_hash": "abcd".repeat(16),
        "cost_usd": 0.0,
        "item_count": 5,
        "cited_claims": 4,
        "total_claims": 7,
    })
}

#[tokio::test]
async fn upsert_then_get_round_trips() {
    let app = router();
    let (status, body) = post_json(
        &app,
        "/api/uber/briefs",
        brief_body("2026-05-01", "input/briefs/2026-05-01.md"),
    )
    .await;
    assert_eq!(status, 200, "upsert: {body}");

    let (status, body) = get_url(&app, "/api/uber/briefs/2026-05-01").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["date"], "2026-05-01");
    assert_eq!(v["kind"], "daily");
    assert_eq!(v["item_count"], 5);
    assert_eq!(v["cited_claims"], 4);
}

#[tokio::test]
async fn upsert_overwrites_existing_date_kind() {
    let app = router();
    post_json(
        &app,
        "/api/uber/briefs",
        brief_body("2026-05-01", "input/briefs/2026-05-01.md"),
    )
    .await;

    let mut second = brief_body("2026-05-01", "input/briefs/2026-05-01.md");
    second["item_count"] = serde_json::json!(9);
    second["cited_claims"] = serde_json::json!(8);
    let (status, _) = post_json(&app, "/api/uber/briefs", second).await;
    assert_eq!(status, 200);

    let (_, body) = get_url(&app, "/api/uber/briefs/2026-05-01").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["item_count"], 9);
    assert_eq!(v["cited_claims"], 8);
}

#[tokio::test]
async fn get_returns_404_when_missing() {
    let app = router();
    let (status, _) = get_url(&app, "/api/uber/briefs/2026-12-31").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn list_returns_briefs_in_reverse_date_order() {
    let app = router();
    for date in ["2026-05-01", "2026-05-03", "2026-05-02"] {
        post_json(
            &app,
            "/api/uber/briefs",
            brief_body(date, &format!("input/briefs/{date}.md")),
        )
        .await;
    }
    let (status, body) = get_url(&app, "/api/uber/briefs").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["date"], "2026-05-03");
    assert_eq!(arr[1]["date"], "2026-05-02");
    assert_eq!(arr[2]["date"], "2026-05-01");
}

#[tokio::test]
async fn list_filters_by_kind() {
    let app = router();
    let mut weekly = brief_body("2026-05-01", "input/briefs/2026-05-01-weekly.md");
    weekly["kind"] = serde_json::json!("weekly");
    post_json(&app, "/api/uber/briefs", weekly).await;
    post_json(
        &app,
        "/api/uber/briefs",
        brief_body("2026-05-02", "input/briefs/2026-05-02.md"),
    )
    .await;

    let (_, body) = get_url(&app, "/api/uber/briefs?kind=weekly").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["date"], "2026-05-01");

    let (_, body) = get_url(&app, "/api/uber/briefs?kind=daily").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["date"], "2026-05-02");
}

#[tokio::test]
async fn upsert_with_failed_reason_records_failed_at() {
    let app = router();
    let mut body = brief_body("2026-05-01", "input/briefs/2026-05-01.md");
    body["failed_reason"] = serde_json::json!("citation verifier rejected fabricated [[slug]]");
    let (status, resp) = post_json(&app, "/api/uber/briefs", body).await;
    assert_eq!(status, 200, "{resp}");
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert!(v["failed_at"].is_string());
    assert!(v["failed_reason"].as_str().unwrap().contains("fabricated"));
}
