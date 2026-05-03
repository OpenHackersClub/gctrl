//! Integration test for `GET /api/sessions?created_by=` and
//! `?kind=internal|external` per
//! `specs/architecture/apps/gctrl-analytics.md` §1.
//!
//! Verifies the spec's M3 acceptance criterion:
//!   filtering kind=external on a workspace with only scheduler-spawned
//!   sessions returns zero rows; kind=internal returns every row.
//!   Totals of the two equal the unfiltered total.

use axum::body::Body;
use gctrl_core::{CreatedBy, DeviceId, Session, SessionId, SessionStatus, WorkspaceId};
use gctrl_otel::create_router_from_arc;
use gctrl_storage::DuckDbStore;
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn store_with_provenance(rows: &[(&str, CreatedBy)]) -> Arc<DuckDbStore> {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    for (id, prov) in rows {
        store
            .insert_session(&Session {
                id: SessionId((*id).into()),
                workspace_id: WorkspaceId("ws".into()),
                device_id: DeviceId("dev".into()),
                agent_name: "agent".into(),
                started_at: chrono::Utc::now(),
                ended_at: None,
                status: SessionStatus::Active,
                total_cost_usd: 0.0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                created_by: *prov,
                project_id: None,
            })
            .unwrap();
    }
    store
}

async fn fetch_ids(app: axum::Router, uri: &str) -> Vec<String> {
    let req = Request::builder()
        .uri(uri)
        .method("GET")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert!(res.status().is_success(), "GET {uri} → {}", res.status());
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn kind_external_filters_to_otel_ingest() {
    let store = store_with_provenance(&[
        ("s-sched", CreatedBy::Scheduler),
        ("s-otel", CreatedBy::OtelIngest),
        ("s-api", CreatedBy::Api),
    ]);
    let app = create_router_from_arc(store);

    let ids = fetch_ids(app, "/api/sessions?kind=external").await;
    assert_eq!(ids, vec!["s-otel"]);
}

#[tokio::test]
async fn kind_internal_filters_to_scheduler_and_api() {
    let store = store_with_provenance(&[
        ("s-sched", CreatedBy::Scheduler),
        ("s-otel", CreatedBy::OtelIngest),
        ("s-api", CreatedBy::Api),
    ]);
    let app = create_router_from_arc(store);

    let mut ids = fetch_ids(app, "/api/sessions?kind=internal").await;
    ids.sort();
    assert_eq!(ids, vec!["s-api", "s-sched"]);
}

#[tokio::test]
async fn internal_plus_external_equals_total() {
    // Spec acceptance: filter totals must add up to the unfiltered total.
    let store = store_with_provenance(&[
        ("s1", CreatedBy::Scheduler),
        ("s2", CreatedBy::OtelIngest),
        ("s3", CreatedBy::OtelIngest),
        ("s4", CreatedBy::Api),
    ]);
    let app = create_router_from_arc(store);

    let total = fetch_ids(app.clone(), "/api/sessions").await.len();
    let internal = fetch_ids(app.clone(), "/api/sessions?kind=internal")
        .await
        .len();
    let external = fetch_ids(app, "/api/sessions?kind=external").await.len();

    assert_eq!(internal + external, total);
    assert_eq!(internal, 2);
    assert_eq!(external, 2);
}

#[tokio::test]
async fn raw_created_by_param_takes_precedence_over_kind() {
    let store = store_with_provenance(&[
        ("s-sched", CreatedBy::Scheduler),
        ("s-otel", CreatedBy::OtelIngest),
    ]);
    let app = create_router_from_arc(store);

    // `created_by` wins; `kind=external` is ignored when both are present.
    let ids = fetch_ids(app, "/api/sessions?created_by=scheduler&kind=external").await;
    assert_eq!(ids, vec!["s-sched"]);
}

#[tokio::test]
async fn auto_created_session_on_otlp_ingest_is_external() {
    // Hitting /v1/traces with a span for an unknown session_id should
    // implicitly create a Session row tagged OtelIngest.
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let app = create_router_from_arc(Arc::clone(&store));

    let payload = serde_json::json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key": "session.id", "value": {"stringValue": "auto-1"}},
                    {"key": "service.name", "value": {"stringValue": "claude-code"}}
                ]
            },
            "scopeSpans": [{
                "spans": [{
                    "traceId": "trace-cb-1",
                    "spanId": "sp-cb-1",
                    "name": "llm.call",
                    "startTimeUnixNano": 1700000000000000000_u64,
                    "endTimeUnixNano": 1700000003000000000_u64,
                    "attributes": [],
                    "status": {"code": 1}
                }]
            }]
        }]
    });
    let req = Request::builder()
        .uri("/v1/traces")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert!(res.status().is_success());

    let ids_external = fetch_ids(app, "/api/sessions?kind=external").await;
    assert_eq!(ids_external, vec!["auto-1"]);
}
