//! Integration test for the M3 follow-up: analytics rollup endpoints
//! accept `?kind=internal|external` and `?created_by=` so totals can be
//! split by provenance without the operator-facing "· all kinds"
//! caveat. See `specs/architecture/apps/gctrl-analytics.md` Milestone M3.
//!
//! Acceptance: cost(internal) + cost(external) == cost(all) for both
//! `by_model` and `by_agent`. Same shape for latency and spans.

use axum::body::Body;
use chrono::{Duration, Utc};
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

    // Two scheduler-spawned sessions ("internal") and one OTLP-ingested
    // session ("external"). Each gets one Generation span with a
    // distinct cost so totals are easy to eyeball.
    for (id, agent, prov, cost) in [
        ("s-sched-1", "scheduler-agent", CreatedBy::Scheduler, 0.10),
        ("s-api-1", "api-agent", CreatedBy::Api, 0.20),
        ("s-otel-1", "external-agent", CreatedBy::OtelIngest, 0.40),
    ] {
        store
            .insert_session(&Session {
                id: SessionId(id.into()),
                workspace_id: WorkspaceId("ws".into()),
                device_id: DeviceId("dev".into()),
                agent_name: agent.into(),
                started_at: now,
                ended_at: Some(now + Duration::seconds(10)),
                status: SessionStatus::Completed,
                total_cost_usd: cost,
                total_input_tokens: 100,
                total_output_tokens: 50,
                created_by: prov,
                project_id: None,
                kind: gctrl_core::default_session_kind(),
                metadata: None,
            })
            .unwrap();

        store
            .insert_span(&Span {
                span_id: SpanId(format!("span-{id}")),
                trace_id: TraceId(format!("trace-{id}")),
                parent_span_id: None,
                session_id: SessionId(id.into()),
                agent_name: agent.into(),
                operation_name: "llm.call".into(),
                span_type: SpanType::Generation,
                model: Some("claude-opus-4".into()),
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: cost,
                status: SpanStatus::Ok,
                started_at: now,
                duration_ms: 1_500,
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

fn sum_costs(by: &serde_json::Value) -> f64 {
    by.as_array()
        .unwrap()
        .iter()
        .map(|r| r["cost"].as_f64().unwrap())
        .sum()
}

#[tokio::test]
async fn analytics_cost_split_by_kind_sums_to_total() {
    let app = create_router_from_arc(fixture_store());

    let all = fetch_json(app.clone(), "/api/analytics/cost").await;
    let internal = fetch_json(app.clone(), "/api/analytics/cost?kind=internal").await;
    let external = fetch_json(app, "/api/analytics/cost?kind=external").await;

    let total_by_model = sum_costs(&all["by_model"]);
    let total_by_agent = sum_costs(&all["by_agent"]);

    let int_by_model = sum_costs(&internal["by_model"]);
    let ext_by_model = sum_costs(&external["by_model"]);
    assert!(
        (int_by_model + ext_by_model - total_by_model).abs() < 1e-9,
        "by_model: internal {int_by_model} + external {ext_by_model} != total {total_by_model}",
    );

    let int_by_agent = sum_costs(&internal["by_agent"]);
    let ext_by_agent = sum_costs(&external["by_agent"]);
    assert!(
        (int_by_agent + ext_by_agent - total_by_agent).abs() < 1e-9,
        "by_agent: internal {int_by_agent} + external {ext_by_agent} != total {total_by_agent}",
    );

    // Spec sanity: external should isolate the OtelIngest row.
    let ext_agents: Vec<String> = external["by_agent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["agent"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ext_agents, vec!["external-agent"]);
}

#[tokio::test]
async fn analytics_overview_split_by_kind_sums_to_total() {
    let app = create_router_from_arc(fixture_store());

    let all = fetch_json(app.clone(), "/api/analytics").await;
    let internal = fetch_json(app.clone(), "/api/analytics?kind=internal").await;
    let external = fetch_json(app, "/api/analytics?kind=external").await;

    let total_sessions = all["total_sessions"].as_u64().unwrap();
    let total_spans = all["total_spans"].as_u64().unwrap();
    let total_cost = all["total_cost_usd"].as_f64().unwrap();

    assert_eq!(
        internal["total_sessions"].as_u64().unwrap()
            + external["total_sessions"].as_u64().unwrap(),
        total_sessions,
        "sessions split must add up",
    );
    assert_eq!(
        internal["total_spans"].as_u64().unwrap() + external["total_spans"].as_u64().unwrap(),
        total_spans,
        "spans split must add up",
    );
    let split_cost =
        internal["total_cost_usd"].as_f64().unwrap() + external["total_cost_usd"].as_f64().unwrap();
    assert!(
        (split_cost - total_cost).abs() < 1e-9,
        "cost split must add up: {split_cost} vs {total_cost}",
    );

    // 2 internal (scheduler + api) + 1 external (otel_ingest) = 3
    assert_eq!(internal["total_sessions"].as_u64().unwrap(), 2);
    assert_eq!(external["total_sessions"].as_u64().unwrap(), 1);
}

#[tokio::test]
async fn analytics_spans_distribution_respects_kind() {
    let app = create_router_from_arc(fixture_store());

    let all = fetch_json(app.clone(), "/api/analytics/spans").await;
    let external = fetch_json(app, "/api/analytics/spans?kind=external").await;

    // Three spans total, one is external.
    let all_count: u64 = all["distribution"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["count"].as_u64().unwrap())
        .sum();
    let ext_count: u64 = external["distribution"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["count"].as_u64().unwrap())
        .sum();
    assert_eq!(all_count, 3);
    assert_eq!(ext_count, 1);

    // External-only percentage of `generation` spans is 100% of the
    // filtered population — confirms the percentage is computed against
    // the filtered total, not the unfiltered total.
    let ext_pct = external["distribution"][0]["percentage"].as_f64().unwrap();
    assert!((ext_pct - 100.0).abs() < 1e-9);
}

#[tokio::test]
async fn analytics_latency_respects_kind() {
    let app = create_router_from_arc(fixture_store());

    let internal = fetch_json(app.clone(), "/api/analytics/latency?kind=internal").await;
    let external = fetch_json(app, "/api/analytics/latency?kind=external").await;

    // Each kind should still report claude-opus-4 because each
    // population has at least one generation span on that model.
    for v in [&internal, &external] {
        let models: Vec<String> = v["by_model"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["model"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(models, vec!["claude-opus-4"]);
    }
}

#[tokio::test]
async fn analytics_raw_created_by_param_is_honoured() {
    let app = create_router_from_arc(fixture_store());

    // `?created_by=otel_ingest` should match exactly the same row as
    // `?kind=external` for our fixture.
    let by_kind = fetch_json(app.clone(), "/api/analytics/cost?kind=external").await;
    let by_raw = fetch_json(app, "/api/analytics/cost?created_by=otel_ingest").await;
    assert_eq!(by_kind, by_raw);
}
