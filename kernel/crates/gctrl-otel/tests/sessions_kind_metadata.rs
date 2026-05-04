//! Generic `POST /api/sessions` accepts arbitrary `kind` + `metadata`.
//!
//! Apps that own session-shaped run records (e.g. uebermensch's SinkIn)
//! call this endpoint with their own `kind` (e.g. `"uber.sinkin"`) and
//! put domain-specific fields under `metadata`. The kernel never
//! interprets either — it stores them verbatim and gives them back.

use axum::body::Body;
use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

use gctrl_otel::create_router;
use gctrl_storage::DuckDbStore;

#[tokio::test]
async fn post_sessions_round_trips_kind_and_metadata() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    let body = serde_json::json!({
        "id": "sinkin-2026-05-04-abc123",
        "kind": "uber.sinkin",
        "started_at": "2026-05-04T08:00:00Z",
        "completed_at": null,
        "status": "active",
        "cost_usd": 0.0,
        "metadata": {
            "mode": "manual",
            "scope_kind": "topic",
            "scope_value": "ai-capex",
            "pages_scanned": 84,
            "gaps_found": 6
        }
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201, "POST /api/sessions should return 201");

    let written: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(written["kind"], "uber.sinkin");
    assert_eq!(written["metadata"]["scope_kind"], "topic");

    // Round-trip via GET.
    let req = Request::builder()
        .uri("/api/sessions/sinkin-2026-05-04-abc123")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let got: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(got["kind"], "uber.sinkin");
    assert_eq!(got["metadata"]["pages_scanned"], 84);
    assert_eq!(got["metadata"]["scope_value"], "ai-capex");
}

#[tokio::test]
async fn post_sessions_defaults_kind_to_llm_when_absent() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    let body = serde_json::json!({
        "id": "no-kind-session",
        "started_at": "2026-05-04T08:00:00Z",
        "status": "active"
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);
    let written: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        written["kind"], "llm",
        "missing kind should default to 'llm' for back-compat with OTel sessions"
    );
}
