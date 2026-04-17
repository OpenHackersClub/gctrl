//! Full pipeline integration test: ingest -> query -> score -> tree -> analytics

use axum::body::Body;
use gctrl_otel::create_router;
use gctrl_storage::DuckDbStore;
use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn test_app() -> axum::Router {
    let store = DuckDbStore::open(":memory:").unwrap();
    create_router(store)
}

fn otlp_payload() -> serde_json::Value {
    serde_json::json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key": "session.id", "value": {"stringValue": "integ-session-1"}},
                    {"key": "service.name", "value": {"stringValue": "claude-code"}}
                ]
            },
            "scopeSpans": [{
                "spans": [
                    {
                        "traceId": "trace-integ-1",
                        "spanId": "gen-001",
                        "name": "llm.call",
                        "startTimeUnixNano": 1700000000000000000_u64,
                        "endTimeUnixNano": 1700000003000000000_u64,
                        "attributes": [
                            {"key": "ai.model.id", "value": {"stringValue": "claude-opus-4-6"}},
                            {"key": "ai.tokens.input", "value": {"intValue": 2500}},
                            {"key": "ai.tokens.output", "value": {"intValue": 1200}},
                            {"key": "ai.cost.usd", "value": {"doubleValue": 0.18}}
                        ],
                        "status": {"code": 1}
                    },
                    {
                        "traceId": "trace-integ-1",
                        "spanId": "tool-001",
                        "parentSpanId": "gen-001",
                        "name": "tool.bash",
                        "startTimeUnixNano": 1700000003000000000_u64,
                        "endTimeUnixNano": 1700000005000000000_u64,
                        "attributes": [
                            {"key": "ai.tool.name", "value": {"stringValue": "bash"}}
                        ],
                        "status": {"code": 1}
                    },
                    {
                        "traceId": "trace-integ-1",
                        "spanId": "gen-002",
                        "name": "llm.call",
                        "startTimeUnixNano": 1700000005000000000_u64,
                        "endTimeUnixNano": 1700000008000000000_u64,
                        "attributes": [
                            {"key": "ai.model.id", "value": {"stringValue": "claude-opus-4-6"}},
                            {"key": "ai.tokens.input", "value": {"intValue": 3200}},
                            {"key": "ai.tokens.output", "value": {"intValue": 1800}},
                            {"key": "ai.cost.usd", "value": {"doubleValue": 0.24}}
                        ],
                        "status": {"code": 1}
                    }
                ]
            }]
        }]
    })
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
    let req = Request::builder()
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

#[tokio::test]
async fn test_full_analytics_pipeline() {
    let app = test_app();

    // 1. Ingest OTLP spans (3 spans: 2 generations + 1 tool)
    let (status, _) = post_json(&app, "/v1/traces", otlp_payload()).await;
    assert_eq!(status, 200);

    // 2. Verify session with aggregated cost ($0.18 + $0.24 = $0.42)
    let (status, sessions) = get_json(&app, "/api/sessions").await;
    assert_eq!(status, 200);
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["agent_name"], "claude-code");
    let cost = sessions[0]["total_cost_usd"].as_f64().unwrap();
    assert!((cost - 0.42).abs() < 0.001, "expected 0.42, got {cost}");

    // 3. Verify 3 spans stored
    let (status, spans) = get_json(&app, "/api/sessions/integ-session-1/spans").await;
    assert_eq!(status, 200);
    assert_eq!(spans.as_array().unwrap().len(), 3);

    // 4. Trace tree: 2 root spans, gen-001 has 1 child
    let (status, tree) = get_json(&app, "/api/sessions/integ-session-1/tree").await;
    assert_eq!(status, 200);
    assert_eq!(tree["span_count"], 3);
    let tree_spans = tree["spans"].as_array().unwrap();
    assert_eq!(tree_spans.len(), 2);
    let gen001 = tree_spans.iter().find(|s| s["span_id"] == "gen-001").unwrap();
    assert_eq!(gen001["type"], "generation");
    assert_eq!(gen001["children"].as_array().unwrap().len(), 1);
    assert_eq!(gen001["children"][0]["type"], "span");

    // 5. Auto-score the session
    let (status, scores) = post_json(
        &app, "/api/sessions/integ-session-1/auto-score", serde_json::json!({})
    ).await;
    assert_eq!(status, 200);
    let scores = scores.as_array().unwrap();
    let span_count = scores.iter().find(|s| s["name"] == "span_count").unwrap();
    assert_eq!(span_count["value"], 3.0);
    let gen_count = scores.iter().find(|s| s["name"] == "generation_count").unwrap();
    assert_eq!(gen_count["value"], 2.0);

    // 6. Create human score + tag
    let (s1, _) = post_json(&app, "/api/analytics/score", serde_json::json!({
        "target_type": "session", "target_id": "integ-session-1",
        "name": "quality", "value": 4.5
    })).await;
    assert_eq!(s1, 201);

    let (s2, _) = post_json(&app, "/api/analytics/tag", serde_json::json!({
        "target_type": "session", "target_id": "integ-session-1",
        "key": "project", "value": "api-server"
    })).await;
    assert_eq!(s2, 201);

    // 7. Tree now includes scores and tags
    let (_, tree) = get_json(&app, "/api/sessions/integ-session-1/tree").await;
    let tree_scores = tree["scores"].as_array().unwrap();
    assert!(tree_scores.len() >= 4);
    let tree_tags = tree["tags"].as_array().unwrap();
    assert_eq!(tree_tags.len(), 1);
    assert_eq!(tree_tags[0]["key"], "project");

    // 8. Cost analytics
    let (_, cost_data) = get_json(&app, "/api/analytics/cost").await;
    let by_model = cost_data["by_model"].as_array().unwrap();
    assert_eq!(by_model[0]["model"], "claude-opus-4-6");
    let model_cost = by_model[0]["cost"].as_f64().unwrap();
    assert!((model_cost - 0.42).abs() < 0.001);

    // 9. Latency analytics
    let (_, latency_data) = get_json(&app, "/api/analytics/latency").await;
    assert!(!latency_data["by_model"].as_array().unwrap().is_empty());

    // 10. Score summary
    let (_, summary) = get_json(&app, "/api/analytics/scores?name=quality").await;
    assert_eq!(summary["total"], 1);
    assert_eq!(summary["avg_value"], 4.5);

    // 11. Overall analytics
    let (_, analytics) = get_json(&app, "/api/analytics").await;
    assert_eq!(analytics["total_sessions"], 1);
    assert_eq!(analytics["total_spans"], 3);
}

#[tokio::test]
async fn test_tree_not_found() {
    let app = test_app();
    let req = Request::builder()
        .uri("/api/sessions/nonexistent/tree")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), 404);
}
