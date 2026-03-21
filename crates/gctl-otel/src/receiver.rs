use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gctl_storage::DuckDbStore;

use crate::span_processor::{self, OtlpExportRequest};

pub struct AppState {
    pub store: DuckDbStore,
}

pub fn create_router(store: DuckDbStore) -> Router {
    let state = Arc::new(AppState { store });
    Router::new()
        .route("/v1/traces", post(ingest_traces))
        .route("/health", get(health))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
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
    async fn test_ingest_traces_with_spans() {
        let app = test_app();
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

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
