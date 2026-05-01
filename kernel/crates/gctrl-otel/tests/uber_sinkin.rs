//! Integration tests for `/api/uber/sinkin/sessions` routes.
//!
//! SinkIn introspects the wiki and files Question + Connection markdown
//! pages (those live in the vault). This index tracks the run itself —
//! cost, scope, counts — so the dashboard can list recent runs without
//! scanning the whole vault.

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

#[tokio::test]
async fn upsert_open_then_close_round_trips() {
    let app = router();

    // Open a session in `running` state.
    let (status, body) = post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({
            "id": "sinkin-2026-05-01-001",
            "status": "running",
            "mode": "manual",
            "scope_kind": "topic",
            "scope_value": "ai-infrastructure",
        }),
    )
    .await;
    assert_eq!(status, 200, "open: {body}");

    // Update with counts + complete it.
    let (status, body) = post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({
            "id": "sinkin-2026-05-01-001",
            "status": "completed",
            "mode": "manual",
            "pages_scanned": 42,
            "gaps_found": 5,
            "gaps_answered": 3,
            "connections_found": 2,
            "cost_usd": 0.15,
            "model": "google/gemma-4-31b",
            "completed_at": "2026-05-01T12:34:56Z",
        }),
    )
    .await;
    assert_eq!(status, 200, "close: {body}");

    let (status, body) = get_url(&app, "/api/uber/sinkin/sessions/sinkin-2026-05-01-001").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["status"], "completed");
    assert_eq!(v["pages_scanned"], 42);
    assert_eq!(v["gaps_found"], 5);
    assert_eq!(v["gaps_answered"], 3);
    assert_eq!(v["connections_found"], 2);
    assert!(v["completed_at"].is_string());
}

#[tokio::test]
async fn upsert_preserves_started_at_across_updates() {
    let app = router();
    post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({
            "id": "sinkin-1",
            "status": "running",
            "mode": "manual",
        }),
    )
    .await;
    let (_, body) = get_url(&app, "/api/uber/sinkin/sessions/sinkin-1").await;
    let v1: serde_json::Value = serde_json::from_str(&body).unwrap();
    let started_first = v1["started_at"].as_str().unwrap().to_string();

    // Sleep a tick, then update; started_at should remain.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({
            "id": "sinkin-1",
            "status": "completed",
            "mode": "manual",
            "pages_scanned": 7,
        }),
    )
    .await;
    let (_, body) = get_url(&app, "/api/uber/sinkin/sessions/sinkin-1").await;
    let v2: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v2["started_at"].as_str().unwrap(), started_first);
    assert_eq!(v2["pages_scanned"], 7);
}

#[tokio::test]
async fn get_returns_404_when_missing() {
    let app = router();
    let (status, _) = get_url(&app, "/api/uber/sinkin/sessions/nonexistent").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn list_returns_sessions_in_reverse_start_order() {
    let app = router();
    for (i, id) in ["sinkin-a", "sinkin-b", "sinkin-c"].iter().enumerate() {
        post_json(
            &app,
            "/api/uber/sinkin/sessions",
            serde_json::json!({"id": id, "status": "running", "mode": "manual"}),
        )
        .await;
        // Force ordering — started_at is stamped at first upsert.
        if i < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    let (status, body) = get_url(&app, "/api/uber/sinkin/sessions").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["id"], "sinkin-c");
    assert_eq!(arr[2]["id"], "sinkin-a");
}

#[tokio::test]
async fn list_filters_by_status() {
    let app = router();
    post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({"id": "open-1", "status": "running", "mode": "manual"}),
    )
    .await;
    post_json(
        &app,
        "/api/uber/sinkin/sessions",
        serde_json::json!({"id": "done-1", "status": "completed", "mode": "manual"}),
    )
    .await;

    let (_, body) = get_url(&app, "/api/uber/sinkin/sessions?status=completed").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["id"], "done-1");

    let (_, body) = get_url(&app, "/api/uber/sinkin/sessions?status=running").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["id"], "open-1");
}
