//! Integration tests for /api/memory/* routes.

use axum::body::Body;
use gctl_otel::create_router;
use gctl_storage::DuckDbStore;
use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn test_app() -> axum::Router {
    let store = DuckDbStore::open(":memory:").unwrap();
    create_router(store)
}

async fn post_json(app: &axum::Router, uri: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

async fn get_json(app: &axum::Router, uri: &str) -> (u16, serde_json::Value) {
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

async fn delete_req(app: &axum::Router, uri: &str) -> u16 {
    let req = Request::builder()
        .method("DELETE")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status().as_u16()
}

#[tokio::test]
async fn memory_upsert_get_list_delete() {
    let app = test_app();

    // Create
    let (status, created) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "feedback",
        "name": "no_bun",
        "description": "use pnpm not bun",
        "body": "User explicitly rejected bun — always use pnpm.",
        "tags": ["tooling"],
        "device_id": "dev-test",
    })).await;
    assert_eq!(status, 201);
    let id = created["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("mem-"));
    assert_eq!(created["type"], "feedback");
    assert_eq!(created["synced"], false);

    // Get
    let (status, fetched) = get_json(&app, &format!("/api/memory/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(fetched["name"], "no_bun");
    assert_eq!(fetched["device_id"], "dev-test");

    // List
    let (status, all) = get_json(&app, "/api/memory").await;
    assert_eq!(status, 200);
    assert_eq!(all.as_array().unwrap().len(), 1);

    // Filter by type
    let (_, filtered) = get_json(&app, "/api/memory?type=feedback").await;
    assert_eq!(filtered.as_array().unwrap().len(), 1);
    let (_, none) = get_json(&app, "/api/memory?type=user").await;
    assert_eq!(none.as_array().unwrap().len(), 0);

    // Stats
    let (status, stats) = get_json(&app, "/api/memory/stats").await;
    assert_eq!(status, 200);
    assert_eq!(stats["total_entries"], 1);
    assert_eq!(stats["unsynced"], 1);

    // Delete
    let status = delete_req(&app, &format!("/api/memory/{id}")).await;
    assert_eq!(status, 204);
    let (status, _) = get_json(&app, &format!("/api/memory/{id}")).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn memory_upsert_rejects_bad_input() {
    let app = test_app();

    let (status, _) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "invalid_type",
        "name": "x",
        "device_id": "dev-1",
    })).await;
    assert_eq!(status, 400);

    let (status, _) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "user",
        "name": "",
        "device_id": "dev-1",
    })).await;
    assert_eq!(status, 400);

    let (status, _) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "user",
        "name": "ok",
        "device_id": "",
    })).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn memory_upsert_same_device_name_updates() {
    let app = test_app();

    let (_, first) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "project",
        "name": "sprint_goal",
        "body": "ship memory v1",
        "device_id": "dev-A",
    })).await;
    let id = first["id"].as_str().unwrap().to_string();

    let (_, _) = post_json(&app, "/api/memory", serde_json::json!({
        "type": "project",
        "name": "sprint_goal",
        "body": "ship memory v1 + D1 sync",
        "device_id": "dev-A",
    })).await;

    // First id should still be the canonical one because upsert matches (device_id, name)
    let (status, fetched) = get_json(&app, &format!("/api/memory/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(fetched["body"], "ship memory v1 + D1 sync");

    let (_, all) = get_json(&app, "/api/memory").await;
    assert_eq!(all.as_array().unwrap().len(), 1, "upsert should not create a duplicate row");
}
