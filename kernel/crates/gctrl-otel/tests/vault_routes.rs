//! Integration tests for `/api/vault/*` routes.
//!
//! Covers: register a mount → list it → write a page → read it back →
//! reject path-traversal → delete the mount.

use axum::body::Body;
use gctrl_core::NetConfig;
use gctrl_otel::create_router_full;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tempfile::TempDir;
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

async fn delete_url(app: &axum::Router, uri: &str) -> u16 {
    let req = Request::builder()
        .method("DELETE")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status().as_u16()
}

#[tokio::test]
async fn mount_lifecycle_create_list_delete() {
    let app = router();
    let dir = TempDir::new().unwrap();

    let (status, body) = post_json(
        &app,
        "/api/vault/mounts",
        serde_json::json!({
            "name": "personal",
            "root_path": dir.path().to_string_lossy(),
            "kind": "workspace",
        }),
    )
    .await;
    assert_eq!(status, 201, "create returned: {body}");

    let (status, body) = get_url(&app, "/api/vault/mounts").await;
    assert_eq!(status, 200);
    let mounts: serde_json::Value = serde_json::from_str(&body).unwrap();
    let arr = mounts.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["name"], "personal");
    assert_eq!(arr[0]["kind"], "workspace");

    assert_eq!(delete_url(&app, "/api/vault/mounts/personal").await, 204);

    let (_, body) = get_url(&app, "/api/vault/mounts").await;
    let mounts: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(mounts.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn create_mount_with_duplicate_name_conflicts() {
    let app = router();
    let dir = TempDir::new().unwrap();
    let body = serde_json::json!({
        "name": "kb",
        "root_path": dir.path().to_string_lossy(),
    });
    let (s1, _) = post_json(&app, "/api/vault/mounts", body.clone()).await;
    let (s2, _) = post_json(&app, "/api/vault/mounts", body).await;
    assert_eq!(s1, 201);
    assert_eq!(s2, 409);
}

#[tokio::test]
async fn vault_page_put_then_get_round_trips_content() {
    let app = router();
    let dir = TempDir::new().unwrap();

    let (status, _) = post_json(
        &app,
        "/api/vault/mounts",
        serde_json::json!({"name": "kb", "root_path": dir.path().to_string_lossy()}),
    )
    .await;
    assert_eq!(status, 201);

    let (status, body) = post_json(
        &app,
        "/api/vault/page",
        serde_json::json!({
            "mount": "kb",
            "path": "notes/hello.md",
            "content": "# hello\nworld\n",
        }),
    )
    .await;
    assert_eq!(status, 200, "put returned: {body}");
    let written: serde_json::Value = serde_json::from_str(&body).unwrap();
    let put_hash = written["content_hash"].as_str().unwrap().to_string();
    assert_eq!(put_hash.len(), 64);

    let (status, body) = get_url(&app, "/api/vault/page?mount=kb&path=notes/hello.md").await;
    assert_eq!(status, 200);
    let read: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(read["content"], "# hello\nworld\n");
    assert_eq!(read["content_hash"].as_str().unwrap(), put_hash);
}

#[tokio::test]
async fn vault_page_get_returns_404_for_unknown_mount() {
    let app = router();
    let (status, _) = get_url(&app, "/api/vault/page?mount=nope&path=x.md").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn vault_page_get_returns_404_when_file_missing() {
    let app = router();
    let dir = TempDir::new().unwrap();
    post_json(
        &app,
        "/api/vault/mounts",
        serde_json::json!({"name": "kb", "root_path": dir.path().to_string_lossy()}),
    )
    .await;
    let (status, _) = get_url(&app, "/api/vault/page?mount=kb&path=missing.md").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn vault_page_rejects_path_traversal() {
    let app = router();
    let dir = TempDir::new().unwrap();
    post_json(
        &app,
        "/api/vault/mounts",
        serde_json::json!({"name": "kb", "root_path": dir.path().to_string_lossy()}),
    )
    .await;

    let (status, body) = post_json(
        &app,
        "/api/vault/page",
        serde_json::json!({
            "mount": "kb",
            "path": "../escape.md",
            "content": "x",
        }),
    )
    .await;
    assert_eq!(status, 400, "got: {body}");
    assert!(body.contains(".."));

    let (status, body) = post_json(
        &app,
        "/api/vault/page",
        serde_json::json!({
            "mount": "kb",
            "path": "/etc/passwd",
            "content": "x",
        }),
    )
    .await;
    assert_eq!(status, 400, "got: {body}");
}
