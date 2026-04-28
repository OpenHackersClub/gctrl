//! Integration tests for the prompt body read routes:
//!   - `GET /api/sessions/{id}/prompts`
//!   - `GET /api/prompts?group_by=fingerprint&since=...`
//!
//! Spec: `vault/specs/implementation/llm-relay.md` §M1.

use axum::body::Body;
use chrono::{TimeZone, Utc};
use gctrl_core::PromptBody;
use gctrl_otel::create_router_from_arc;
use gctrl_storage::DuckDbStore;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn store_with_prompts() -> Arc<DuckDbStore> {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());

    // Session A: 2 turns, the user turn shares its fingerprint with B.
    store
        .insert_prompt_body(&PromptBody {
            id: "p-a-0".into(),
            session_id: "sess-a".into(),
            span_id: Some("span-a".into()),
            trace_id: Some("trace-a".into()),
            turn_ordinal: 0,
            role: "user".into(),
            content: "hello world".into(),
            fingerprint: "fp-hello".into(),
            tokens: Some(7),
            created_at: Utc.with_ymd_and_hms(2026, 4, 28, 10, 0, 0).unwrap(),
        })
        .unwrap();
    store
        .insert_prompt_body(&PromptBody {
            id: "p-a-1".into(),
            session_id: "sess-a".into(),
            span_id: Some("span-a".into()),
            trace_id: Some("trace-a".into()),
            turn_ordinal: 1,
            role: "assistant".into(),
            content: "hi".into(),
            fingerprint: "fp-hi".into(),
            tokens: Some(2),
            created_at: Utc.with_ymd_and_hms(2026, 4, 28, 10, 0, 1).unwrap(),
        })
        .unwrap();

    // Session B: same user prompt fingerprint as A → grouping should
    // count 2.
    store
        .insert_prompt_body(&PromptBody {
            id: "p-b-0".into(),
            session_id: "sess-b".into(),
            span_id: None,
            trace_id: None,
            turn_ordinal: 0,
            role: "user".into(),
            content: "hello world".into(),
            fingerprint: "fp-hello".into(),
            tokens: Some(7),
            created_at: Utc.with_ymd_and_hms(2026, 4, 28, 11, 0, 0).unwrap(),
        })
        .unwrap();

    store
}

async fn get_json(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value =
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, body)
}

#[tokio::test]
async fn list_session_prompts_returns_turns_in_order() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);

    let (status, body) = get_json(&app, "/api/sessions/sess-a/prompts").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["session_id"], "sess-a");
    assert_eq!(body["count"], 2);
    let prompts = body["prompts"].as_array().unwrap();
    assert_eq!(prompts[0]["role"], "user");
    assert_eq!(prompts[0]["turn_ordinal"], 0);
    assert_eq!(prompts[1]["role"], "assistant");
    assert_eq!(prompts[1]["turn_ordinal"], 1);
}

#[tokio::test]
async fn list_session_prompts_unknown_session_returns_empty() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);
    let (status, body) = get_json(&app, "/api/sessions/does-not-exist/prompts").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 0);
}

#[tokio::test]
async fn group_by_fingerprint_counts_repeated_prompts() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);
    let (status, body) = get_json(&app, "/api/prompts?group_by=fingerprint").await;
    assert_eq!(status, StatusCode::OK);
    let groups = body["groups"].as_array().unwrap();
    // 2 fingerprints: fp-hello (count=2), fp-hi (count=1) → ordered by count desc
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0]["fingerprint"], "fp-hello");
    assert_eq!(groups[0]["count"], 2);
    assert_eq!(groups[0]["session_count"], 2);
    assert_eq!(groups[1]["fingerprint"], "fp-hi");
    assert_eq!(groups[1]["count"], 1);
}

#[tokio::test]
async fn group_by_fingerprint_respects_since_filter() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);
    // Cut between A's rows (10:00) and B's row (11:00)
    let (status, body) = get_json(
        &app,
        "/api/prompts?group_by=fingerprint&since=2026-04-28T10:30:00Z",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let groups = body["groups"].as_array().unwrap();
    // Only B's user turn remains → fp-hello count=1
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0]["fingerprint"], "fp-hello");
    assert_eq!(groups[0]["count"], 1);
}

#[tokio::test]
async fn list_prompts_without_group_by_is_400() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);
    let (status, _) = get_json(&app, "/api/prompts").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn list_prompts_with_unknown_group_by_is_400() {
    let store = store_with_prompts();
    let app = create_router_from_arc(store);
    let (status, _) = get_json(&app, "/api/prompts?group_by=role").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
