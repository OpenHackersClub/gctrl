//! Integration tests for the proxy-side `/api/net/*` and `/v1/{logs,metrics}`
//! routes. The receiver route table is the kernel's stable contract — these
//! tests pin the shapes the shell relies on.

use axum::body::Body;
use chrono::Utc;
use gctrl_core::{NetConfig, TrafficRecord};
use gctrl_otel::create_router_full;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn router_with_traffic(records: Vec<TrafficRecord>) -> axum::Router {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    for r in &records {
        store.insert_traffic(r).unwrap();
    }
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    create_router_full(store, sqlite, None, Arc::new(NetConfig::default()))
}

fn sample_record(host: &str) -> TrafficRecord {
    TrafficRecord {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: Utc::now(),
        method: "GET".into(),
        url: format!("https://{host}/x"),
        host: host.into(),
        status_code: 200,
        request_size_bytes: 0,
        response_size_bytes: 100,
        duration_ms: 5,
        session_id: None,
    }
}

async fn get(app: &axum::Router, uri: &str) -> (u16, String) {
    let req = Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn post_json(app: &axum::Router, uri: &str, body: serde_json::Value) -> u16 {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status().as_u16()
}

#[tokio::test]
async fn net_logs_returns_traffic_rows() {
    let app = router_with_traffic(vec![sample_record("a.com"), sample_record("b.com")]);
    let (status, body) = get(&app, "/api/net/logs").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn net_logs_filters_by_host() {
    let app = router_with_traffic(vec![sample_record("a.com"), sample_record("b.com")]);
    let (status, body) = get(&app, "/api/net/logs?host=a.com").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["host"], "a.com");
}

#[tokio::test]
async fn net_stats_returns_aggregates() {
    let app = router_with_traffic(vec![sample_record("a.com")]);
    let (status, body) = get(&app, "/api/net/stats").await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["total_requests"], 1);
}

#[tokio::test]
async fn net_proxy_ca_404_when_not_generated() {
    // ProxyConfig::ca_dir() points at the user's data dir, so on CI without a
    // generated CA the route returns 404. We only assert the contract.
    let app = router_with_traffic(vec![]);
    let (status, _) = get(&app, "/api/net/ca").await;
    assert!(status == 200 || status == 404, "expected 200 or 404, got {status}");
}

#[tokio::test]
async fn ingest_logs_returns_200_on_empty_payload() {
    let app = router_with_traffic(vec![]);
    let status = post_json(&app, "/v1/logs", serde_json::json!({})).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn ingest_metrics_returns_200_on_empty_payload() {
    let app = router_with_traffic(vec![]);
    let status = post_json(&app, "/v1/metrics", serde_json::json!({})).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn ingest_logs_accepts_otlp_shape() {
    let app = router_with_traffic(vec![]);
    let payload = serde_json::json!({
        "resourceLogs": [{
            "resource": {"attributes": []},
            "scopeLogs": [{
                "logRecords": [
                    {"timeUnixNano": "0", "body": {"stringValue": "hello"}}
                ]
            }]
        }]
    });
    let status = post_json(&app, "/v1/logs", payload).await;
    assert_eq!(status, 200);
}
