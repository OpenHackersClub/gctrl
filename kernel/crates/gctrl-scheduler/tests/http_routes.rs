//! Integration tests for the scheduler HTTP routes — exercises the full
//! axum Router with an in-memory SqliteStore.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use gctrl_core::SchedulerConfig;
use gctrl_scheduler::http;
use gctrl_storage::SqliteStore;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn router() -> axum::Router {
    router_with_cfg(SchedulerConfig::default())
}

fn router_with_cfg(cfg: SchedulerConfig) -> axum::Router {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    http::router(store, Arc::new(cfg))
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

#[tokio::test]
async fn list_starts_empty() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedules"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn create_then_list_and_get() {
    let app = router();

    let create_body = serde_json::json!({
        "name": "test.every-2h",
        "cron": "0 */2 * * *",
        "target_url": "http://127.0.0.1:9999/noop",
        "target_method": "POST"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let created = body_json(resp).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "test.every-2h");
    assert!(created["next_run_at"].is_string(), "next_run_at must be precomputed");

    // List shows the row.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["schedules"].as_array().unwrap().len(), 1);

    // GET by id round-trips.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["name"], "test.every-2h");
}

#[tokio::test]
async fn create_rejects_bad_cron() {
    let app = router();
    let body = serde_json::json!({
        "name": "broken",
        "cron": "not-a-cron",
        "target_url": "http://x"
    });
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_returns_no_content_then_404() {
    let app = router();
    let body = serde_json::json!({
        "name": "to-delete",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_route_404_when_schedule_missing() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/does-not-exist/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_route_returns_empty_for_no_history() {
    let app = router();
    let body = serde_json::json!({
        "name": "fresh",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}/runs", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedule_id"], id);
    assert_eq!(json["runs"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn runs_route_resolves_schedule_by_name() {
    // The dynamic-id route MUST accept either id or human-readable name —
    // mirrors the existing /api/schedules/{id} behaviour. The Schedule
    // page deep-links use the routine name for readability.
    let app = router();
    let body = serde_json::json!({
        "name": "audit.codebase",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/audit.codebase/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedule_name"], "audit.codebase");
}

#[tokio::test]
async fn global_runs_feed_empty_initially() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["runs"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn global_runs_feed_does_not_collide_with_id_route() {
    // `/api/schedules/runs` MUST resolve to the global feed, not be
    // interpreted as `/api/schedules/{id}` with id="runs". Regression
    // guard for axum's longest-match semantics.
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // If shadowed by `{id}`, this would be 404 (no schedule named "runs").
    // We expect 200 with a runs feed.
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json["runs"].is_array());
}

#[tokio::test]
async fn disable_clears_due_status() {
    let app = router();
    let body = serde_json::json!({
        "name": "togglable",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/schedules/{}/disable", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["enabled"], false);
}
