use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gctl_storage::DuckDbStore;
use serde::Deserialize;

use crate::span_processor::{self, OtlpExportRequest};

pub struct AppState {
    pub store: DuckDbStore,
}

pub fn create_router(store: DuckDbStore) -> Router {
    let state = Arc::new(AppState { store });
    Router::new()
        // OTel ingestion
        .route("/v1/traces", post(ingest_traces))
        // Query endpoints
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{session_id}", get(get_session))
        .route("/api/sessions/{session_id}/spans", get(get_spans))
        .route("/api/analytics", get(get_analytics))
        .route("/api/analytics/cost", get(analytics_cost))
        .route("/api/analytics/latency", get(analytics_latency))
        .route("/api/analytics/scores", get(analytics_scores))
        .route("/api/analytics/daily", get(analytics_daily))
        .route("/api/analytics/score", post(create_score))
        .route("/api/analytics/tag", post(create_tag))
        .route("/api/analytics/alerts", get(list_alerts))
        // Trace tree (Langfuse-style)
        .route("/api/sessions/{session_id}/tree", get(get_trace_tree))
        // Auto-score
        .route("/api/sessions/{session_id}/auto-score", post(auto_score_session))
        // Health
        .route("/health", get(health))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    20
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> impl IntoResponse {
    match state.store.list_sessions(params.limit) {
        Ok(sessions) => Json(serde_json::to_value(&sessions).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session(&gctl_core::SessionId(session_id.clone())) {
        Ok(Some(session)) => Json(serde_json::to_value(&session).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("session {session_id} not found")).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_spans(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.query_spans(&gctl_core::SessionId(session_id)) {
        Ok(spans) => Json(serde_json::to_value(&spans).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_trace_tree(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sid = gctl_core::SessionId(session_id.clone());
    let session = match state.store.get_session(&sid) {
        Ok(Some(s)) => s,
        Ok(None) => return (StatusCode::NOT_FOUND, format!("session {session_id} not found")).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let spans = match state.store.query_spans(&sid) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let scores = state.store.get_scores("session", &session_id).unwrap_or_default();
    let tags = state.store.get_tags("session", &session_id).unwrap_or_default();

    // Build tree: root spans (no parent) with children nested
    let root_spans: Vec<&gctl_core::Span> = spans.iter()
        .filter(|s| s.parent_span_id.is_none())
        .collect();

    let build_node = |span: &gctl_core::Span| -> serde_json::Value {
        let children: Vec<serde_json::Value> = spans.iter()
            .filter(|s| s.parent_span_id.as_ref().map(|p| &p.0) == Some(&span.span_id.0))
            .map(|child| {
                serde_json::json!({
                    "span_id": child.span_id.0,
                    "type": child.span_type.as_str(),
                    "operation": child.operation_name,
                    "model": child.model,
                    "input_tokens": child.input_tokens,
                    "output_tokens": child.output_tokens,
                    "cost_usd": child.cost_usd,
                    "duration_ms": child.duration_ms,
                    "status": child.status.as_str(),
                })
            })
            .collect();

        serde_json::json!({
            "span_id": span.span_id.0,
            "type": span.span_type.as_str(),
            "operation": span.operation_name,
            "model": span.model,
            "input_tokens": span.input_tokens,
            "output_tokens": span.output_tokens,
            "cost_usd": span.cost_usd,
            "duration_ms": span.duration_ms,
            "status": span.status.as_str(),
            "children": children,
        })
    };

    let tree: Vec<serde_json::Value> = root_spans.iter().map(|s| build_node(s)).collect();

    Json(serde_json::json!({
        "session": {
            "id": session.id.0,
            "agent_name": session.agent_name,
            "status": session.status.as_str(),
            "total_cost_usd": session.total_cost_usd,
            "total_input_tokens": session.total_input_tokens,
            "total_output_tokens": session.total_output_tokens,
            "started_at": session.started_at.to_rfc3339(),
        },
        "spans": tree,
        "span_count": spans.len(),
        "scores": scores.iter().map(|s| serde_json::json!({"name": s.name, "value": s.value, "source": s.source})).collect::<Vec<_>>(),
        "tags": tags.iter().map(|t| serde_json::json!({"key": t.key, "value": t.value})).collect::<Vec<_>>(),
    })).into_response()
}

async fn auto_score_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.auto_score_session(&session_id) {
        Ok(scores) => (StatusCode::OK, Json(serde_json::to_value(&scores).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_analytics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.get_analytics() {
        Ok(analytics) => Json(serde_json::to_value(&analytics).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn analytics_cost(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cost_by_model = state.store.get_cost_by_model().unwrap_or_default();
    let cost_by_agent = state.store.get_cost_by_agent().unwrap_or_default();
    Json(serde_json::json!({
        "by_model": cost_by_model.iter().map(|(m, c, n)| serde_json::json!({"model": m, "cost": c, "calls": n})).collect::<Vec<_>>(),
        "by_agent": cost_by_agent.iter().map(|(a, c, n)| serde_json::json!({"agent": a, "cost": c, "sessions": n})).collect::<Vec<_>>(),
    })).into_response()
}

async fn analytics_latency(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let latencies = state.store.get_latency_by_model().unwrap_or_default();
    Json(serde_json::json!({
        "by_model": latencies.iter().map(|(m, p50, p95, p99)| serde_json::json!({"model": m, "p50_ms": p50, "p95_ms": p95, "p99_ms": p99})).collect::<Vec<_>>(),
    })).into_response()
}

#[derive(Deserialize)]
struct ScoreQueryParams {
    name: String,
}

async fn analytics_scores(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ScoreQueryParams>,
) -> impl IntoResponse {
    match state.store.get_score_summary(&params.name) {
        Ok((pass, fail, avg)) => Json(serde_json::json!({
            "name": params.name,
            "pass": pass,
            "fail": fail,
            "total": pass + fail,
            "pass_rate": if pass + fail > 0 { pass as f64 / (pass + fail) as f64 } else { 0.0 },
            "avg_value": avg,
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct DailyParams {
    #[serde(default = "default_days")]
    days: u32,
}

fn default_days() -> u32 {
    7
}

async fn analytics_daily(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DailyParams>,
) -> impl IntoResponse {
    match state.store.get_daily_aggregates(params.days) {
        Ok(aggs) => Json(serde_json::to_value(&aggs).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn create_score(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let score = gctl_core::Score {
        id: payload["id"].as_str().unwrap_or(&uuid::Uuid::new_v4().to_string()).to_string(),
        target_type: payload["target_type"].as_str().unwrap_or("session").to_string(),
        target_id: payload["target_id"].as_str().unwrap_or("").to_string(),
        name: payload["name"].as_str().unwrap_or("").to_string(),
        value: payload["value"].as_f64().unwrap_or(0.0),
        comment: payload["comment"].as_str().map(String::from),
        source: payload["source"].as_str().unwrap_or("human").to_string(),
        scored_by: payload["scored_by"].as_str().map(String::from),
        created_at: chrono::Utc::now(),
    };
    match state.store.insert_score(&score) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::json!({"id": score.id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn create_tag(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let tag = gctl_core::Tag {
        id: payload["id"].as_str().unwrap_or(&uuid::Uuid::new_v4().to_string()).to_string(),
        target_type: payload["target_type"].as_str().unwrap_or("session").to_string(),
        target_id: payload["target_id"].as_str().unwrap_or("").to_string(),
        key: payload["key"].as_str().unwrap_or("").to_string(),
        value: payload["value"].as_str().unwrap_or("").to_string(),
    };
    match state.store.insert_tag(&tag) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::json!({"id": tag.id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn list_alerts(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Query alert_events from DuckDB
    // For now, just return the rules since we don't have a list_alert_events method yet
    match state.store.list_alert_rules() {
        Ok(rules) => Json(serde_json::to_value(&rules).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn ingest_traces(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OtlpExportRequest>,
) -> impl IntoResponse {
    let spans = span_processor::process_export_request(&payload);

    if spans.is_empty() {
        return StatusCode::OK;
    }

    // Auto-create sessions for new session IDs
    let mut seen_sessions = std::collections::HashSet::new();
    for span in &spans {
        if seen_sessions.insert(span.session_id.0.clone()) {
            if state.store.get_session(&span.session_id).unwrap_or(None).is_none() {
                let session = gctl_core::Session {
                    id: span.session_id.clone(),
                    workspace_id: gctl_core::WorkspaceId("default".into()),
                    device_id: gctl_core::DeviceId("local".into()),
                    agent_name: span.agent_name.clone(),
                    started_at: span.started_at,
                    ended_at: None,
                    status: gctl_core::SessionStatus::Active,
                    total_cost_usd: 0.0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                };
                let _ = state.store.insert_session(&session);
            }
        }
    }

    match state.store.insert_spans(&spans) {
        Ok(()) => {
            tracing::info!(count = spans.len(), "ingested spans");

            // Check alert rules
            if let Ok(rules) = state.store.list_alert_rules() {
                for session_id_str in &seen_sessions {
                    if let Ok(Some(session)) = state.store.get_session(&gctl_core::SessionId(session_id_str.clone())) {
                        for rule in &rules {
                            let should_fire = match rule.condition_type.as_str() {
                                "session_cost" => session.total_cost_usd > rule.threshold,
                                _ => false,
                            };
                            if should_fire {
                                let alert = gctl_core::AlertEvent {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    rule_id: rule.id.clone(),
                                    session_id: Some(session_id_str.clone()),
                                    timestamp: chrono::Utc::now(),
                                    message: format!(
                                        "[{}] {}: session {} cost ${:.2} exceeds threshold ${:.2}",
                                        rule.action, rule.name, session_id_str, session.total_cost_usd, rule.threshold
                                    ),
                                    acknowledged: false,
                                };
                                let _ = state.store.insert_alert_event(&alert);
                                tracing::warn!(
                                    rule = %rule.name,
                                    session = %session_id_str,
                                    cost = session.total_cost_usd,
                                    threshold = rule.threshold,
                                    "alert fired"
                                );
                            }
                        }
                    }
                }
            }

            StatusCode::OK
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to store spans");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app() -> Router {
        let store = DuckDbStore::open(":memory:").unwrap();
        create_router(store)
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let app = test_app();
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_list_sessions_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/sessions")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_session_not_found() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/sessions/nonexistent")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_ingest_then_query() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let app = create_router(store);

        // Ingest spans
        let body = serde_json::json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        {"key": "session.id", "value": {"stringValue": "test-session"}},
                        {"key": "service.name", "value": {"stringValue": "test-agent"}}
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "abc123",
                        "spanId": "def456",
                        "name": "llm.call",
                        "startTimeUnixNano": 1700000000000000000_u64,
                        "endTimeUnixNano": 1700000002000000000_u64,
                        "attributes": [
                            {"key": "ai.model.id", "value": {"stringValue": "claude-opus-4-6"}},
                            {"key": "ai.tokens.input", "value": {"intValue": 500}},
                            {"key": "ai.tokens.output", "value": {"intValue": 200}}
                        ],
                        "status": {"code": 1}
                    }]
                }]
            }]
        });

        let req = Request::builder()
            .method("POST")
            .uri("/v1/traces")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Query sessions
        let req = Request::builder()
            .uri("/api/sessions")
            .body(Body::empty())
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let sessions: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        assert_eq!(sessions[0]["agent_name"], "test-agent");

        // Query spans
        let req = Request::builder()
            .uri("/api/sessions/test-session/spans")
            .body(Body::empty())
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let spans: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(spans.as_array().unwrap().len(), 1);
        assert_eq!(spans[0]["operation_name"], "llm.call");
        assert_eq!(spans[0]["input_tokens"], 500);

        // Query analytics
        let req = Request::builder()
            .uri("/api/analytics")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let analytics: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(analytics["total_sessions"], 1);
        assert_eq!(analytics["total_spans"], 1);
    }

    #[tokio::test]
    async fn test_ingest_traces_empty() {
        let app = test_app();
        let body = serde_json::json!({"resourceSpans": []});
        let req = Request::builder()
            .method("POST")
            .uri("/v1/traces")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_analytics_cost_empty() {
        let app = test_app();
        let req = Request::builder().uri("/api/analytics/cost").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["by_model"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_analytics_latency_empty() {
        let app = test_app();
        let req = Request::builder().uri("/api/analytics/latency").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_create_score() {
        let app = test_app();
        let body = serde_json::json!({
            "target_type": "session",
            "target_id": "s1",
            "name": "quality",
            "value": 4.5
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/analytics/score")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_create_tag() {
        let app = test_app();
        let body = serde_json::json!({
            "target_type": "session",
            "target_id": "s1",
            "key": "project",
            "value": "api-server"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/analytics/tag")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_analytics_scores_query() {
        let store = DuckDbStore::open(":memory:").unwrap();
        // Insert a score directly
        store.insert_score(&gctl_core::Score {
            id: "s1".into(),
            target_type: "session".into(),
            target_id: "sess1".into(),
            name: "tests_pass".into(),
            value: 1.0,
            comment: None,
            source: "auto".into(),
            scored_by: None,
            created_at: chrono::Utc::now(),
        }).unwrap();

        let app = create_router(store);
        let req = Request::builder()
            .uri("/api/analytics/scores?name=tests_pass")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["pass"], 1);
        assert_eq!(json["total"], 1);
    }
}
