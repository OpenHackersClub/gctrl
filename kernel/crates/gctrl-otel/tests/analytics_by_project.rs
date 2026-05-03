//! Integration test for the project axis on `/api/analytics/cost`.
//! Verifies that the route emits both `by_project` and the
//! `by_agent_project` matrix, that `unassigned` surfaces sessions
//! without a project_id, and that the slices sum back to the agent
//! totals.

use axum::body::Body;
use chrono::Utc;
use gctrl_core::{
    CreatedBy, DeviceId, Session, SessionId, SessionStatus, Span, SpanId, SpanStatus, SpanType,
    TraceId, WorkspaceId,
};
use gctrl_otel::create_router_from_arc;
use gctrl_storage::DuckDbStore;
use http::Request;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn fixture_store() -> Arc<DuckDbStore> {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let now = Utc::now();

    // Three sessions, three (agent, project) pairs incl. an unassigned
    // bucket. Costs picked so each pair is uniquely identifiable.
    for (id, agent, project, cost) in [
        ("s1", "claude", Some("alpha"), 0.10),
        ("s2", "codex", Some("alpha"), 0.20),
        ("s3", "claude", None, 0.40),
    ] {
        store
            .insert_session(&Session {
                id: SessionId(id.into()),
                workspace_id: WorkspaceId("ws".into()),
                device_id: DeviceId("dev".into()),
                agent_name: agent.into(),
                started_at: now,
                ended_at: None,
                status: SessionStatus::Active,
                total_cost_usd: cost,
                total_input_tokens: 0,
                total_output_tokens: 0,
                created_by: CreatedBy::Api,
                project_id: project.map(str::to_string),
            })
            .unwrap();

        store
            .insert_span(&Span {
                span_id: SpanId(format!("sp-{id}")),
                trace_id: TraceId(format!("tr-{id}")),
                parent_span_id: None,
                session_id: SessionId(id.into()),
                agent_name: agent.into(),
                operation_name: "llm.call".into(),
                span_type: SpanType::Generation,
                model: Some("claude-opus-4".into()),
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: cost,
                status: SpanStatus::Ok,
                started_at: now,
                duration_ms: 100,
                attributes: serde_json::json!({}),
                project_id: None,
            })
            .unwrap();
    }
    store
}

async fn fetch_json(app: axum::Router, uri: &str) -> serde_json::Value {
    let req = Request::builder()
        .uri(uri)
        .method("GET")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert!(res.status().is_success(), "GET {uri} → {}", res.status());
    let body = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

fn project_cost(by_project: &serde_json::Value, project: &str) -> f64 {
    by_project
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["project"].as_str() == Some(project))
        .map(|r| r["cost"].as_f64().unwrap())
        .unwrap_or(0.0)
}

fn matrix_cost(matrix: &serde_json::Value, agent: &str, project: &str) -> Option<f64> {
    matrix.as_array().unwrap().iter().find_map(|r| {
        if r["agent"].as_str() == Some(agent) && r["project"].as_str() == Some(project) {
            Some(r["cost"].as_f64().unwrap())
        } else {
            None
        }
    })
}

#[tokio::test]
async fn analytics_cost_emits_by_project_with_unassigned_bucket() {
    let app = create_router_from_arc(fixture_store());
    let v = fetch_json(app, "/api/analytics/cost").await;

    let by_project = &v["by_project"];
    assert!(by_project.is_array(), "by_project must be present");

    assert!((project_cost(by_project, "alpha") - 0.30).abs() < 1e-9);
    assert!((project_cost(by_project, "unassigned") - 0.40).abs() < 1e-9);
}

#[tokio::test]
async fn analytics_cost_emits_agent_project_matrix() {
    let app = create_router_from_arc(fixture_store());
    let v = fetch_json(app, "/api/analytics/cost").await;

    let matrix = &v["by_agent_project"];
    assert!(matrix.is_array(), "by_agent_project must be present");
    assert_eq!(matrix.as_array().unwrap().len(), 3);

    assert_eq!(matrix_cost(matrix, "claude", "alpha"), Some(0.10));
    assert_eq!(matrix_cost(matrix, "codex", "alpha"), Some(0.20));
    assert_eq!(matrix_cost(matrix, "claude", "unassigned"), Some(0.40));
}

#[tokio::test]
async fn agent_project_rows_sum_to_agent_totals() {
    let app = create_router_from_arc(fixture_store());
    let v = fetch_json(app, "/api/analytics/cost").await;

    // Each agent's matrix rows must sum to the per-agent total. This
    // is the integrity check that catches accidental row dropping or
    // double-counting in future query rewrites.
    let by_agent = v["by_agent"].as_array().unwrap();
    let matrix = v["by_agent_project"].as_array().unwrap();
    for agent_row in by_agent {
        let agent = agent_row["agent"].as_str().unwrap();
        let total = agent_row["cost"].as_f64().unwrap();
        let matrix_total: f64 = matrix
            .iter()
            .filter(|r| r["agent"].as_str() == Some(agent))
            .map(|r| r["cost"].as_f64().unwrap())
            .sum();
        assert!(
            (matrix_total - total).abs() < 1e-9,
            "agent {agent}: matrix sum {matrix_total} != by_agent total {total}",
        );
    }
}
