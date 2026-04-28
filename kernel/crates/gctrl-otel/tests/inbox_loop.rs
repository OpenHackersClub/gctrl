//! End-to-end loop test for the inbox slice — exercises the real axum
//! router and real DuckDbStore in-memory, walking the full path:
//!
//!   1. agent posts an `agent_question` (POST /api/inbox/messages)
//!   2. user lists pending messages   (GET  /api/inbox/messages)
//!   3. user reads stats              (GET  /api/inbox/stats)
//!   4. user records an action        (POST /api/inbox/actions)
//!   5. audit row appears             (GET  /api/inbox/actions)
//!   6. message status flips to acted (GET  /api/inbox/messages/{id})
//!
//! This stands in for a daemon smoke test: it uses the same router the
//! gctrld binary mounts on :4318, so the wire format the shell talks to
//! is what's being asserted here.
use std::sync::Arc;

use axum::body::Body;
use gctrl_otel::create_router_dual;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn test_app() -> axum::Router {
    let duck = Arc::new(DuckDbStore::open(":memory:").expect("duckdb"));
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite"));
    create_router_dual(duck, Arc::clone(&sqlite))
}

async fn post_json(app: &axum::Router, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

async fn get_json(app: &axum::Router, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

#[tokio::test]
async fn full_inbox_loop_agent_to_action_audit() {
    let app = test_app();

    // 1. Agent posts a question. The handler auto-creates a thread because
    //    we pass context_type + context_ref instead of an existing thread_id.
    let (status, msg) = post_json(
        &app,
        "/api/inbox/messages",
        json!({
            "source": "agent",
            "kind": "agent_question",
            "urgency": "high",
            "title": "Should I delete the legacy column?",
            "body": "Migration 0042 references it but no live read paths do.",
            "context_type": "issue",
            "context_ref": "BACK-42",
            "thread_title": "BACK-42: Fix auth",
            "project_key": "BACK",
            "requires_action": true,
        }),
    )
    .await;
    assert_eq!(status, 201, "post failed: {msg}");
    let msg_id = msg["id"].as_str().unwrap().to_string();
    let thread_id = msg["thread_id"].as_str().unwrap().to_string();
    assert_eq!(msg["status"], "pending");
    assert_eq!(msg["kind"], "agent_question");

    // 2. User lists pending messages — sees the new question.
    let (status, list) = get_json(&app, "/api/inbox/messages?status=pending").await;
    assert_eq!(status, 200);
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], msg_id);

    // 3. Stats reflect 1 pending, 1 requires-action, plus by_kind/by_urgency.
    let (status, stats) = get_json(&app, "/api/inbox/stats").await;
    assert_eq!(status, 200);
    assert_eq!(stats["total"], 1);
    assert_eq!(stats["pending"], 1);
    assert_eq!(stats["acted"], 0);
    assert_eq!(stats["requires_action"], 1);
    assert_eq!(stats["by_urgency"]["high"], 1);
    assert_eq!(stats["by_kind"]["agent_question"], 1);

    // 4. User records an approve action.
    let (status, action) = post_json(
        &app,
        "/api/inbox/actions",
        json!({
            "message_id": msg_id,
            "action_type": "approve",
            "reason": "verified safe — column has no live readers",
            "actor_id": "user-vinc",
            "actor_name": "Vinc",
        }),
    )
    .await;
    assert_eq!(status, 201, "action failed: {action}");

    // 5. Action audit row is queryable.
    let (status, actions) = get_json(&app, "/api/inbox/actions").await;
    assert_eq!(status, 200);
    let arr = actions.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["message_id"], msg_id);
    assert_eq!(arr[0]["action_type"], "approve");
    assert_eq!(arr[0]["actor_name"], "Vinc");

    // 6. Message status has flipped from pending → acted, so the agent
    //    pickup loop (whenever it lands) can poll for resolved messages.
    let (status, msg_after) = get_json(&app, &format!("/api/inbox/messages/{msg_id}")).await;
    assert_eq!(status, 200);
    assert_eq!(msg_after["status"], "acted");

    // Stats reflect the transition.
    let (_, stats_after) = get_json(&app, "/api/inbox/stats").await;
    assert_eq!(stats_after["pending"], 0);
    assert_eq!(stats_after["acted"], 1);
    assert_eq!(stats_after["requires_action"], 0);

    // Thread pending_count drops to 0.
    let (_, thread) = get_json(&app, &format!("/api/inbox/threads/{thread_id}")).await;
    assert_eq!(thread["pending_count"], 0);
}

#[tokio::test]
async fn agent_can_post_status_update_without_requires_action() {
    let app = test_app();

    // Progress-sharing: agent drops a status_update, no human action needed.
    let (status, msg) = post_json(
        &app,
        "/api/inbox/messages",
        json!({
            "source": "agent",
            "kind": "status_update",
            "urgency": "info",
            "title": "Migration 0042 applied to staging",
            "context_type": "session",
            "context_ref": "sess-001",
            "thread_title": "sess-001",
        }),
    )
    .await;
    assert_eq!(status, 201, "post failed: {msg}");
    assert_eq!(msg["requires_action"], false);

    // requires_action count stays at 0 even though pending is 1.
    let (_, stats) = get_json(&app, "/api/inbox/stats").await;
    assert_eq!(stats["pending"], 1);
    assert_eq!(stats["requires_action"], 0);
}
