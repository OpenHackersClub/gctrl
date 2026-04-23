//! Tier 2 integration tests for Gantt endpoints:
//!   PATCH /api/board/issues/:id/schedule
//!   GET   /api/board/projects/:id/gantt
//!
//! Mirrors apps/gctrl-board/tests/worker/gantt.test.ts so kernel and Worker
//! surfaces stay behavior-identical.

use std::sync::Arc;

use axum::body::Body;
use chrono::Utc;
use gctrl_core::{BoardIssue, BoardProject, IssueStatus};
use gctrl_otel::create_router_dual;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn make_issue(project_id: &str, id: &str) -> BoardIssue {
    let now = Utc::now();
    BoardIssue {
        id: id.into(),
        project_id: project_id.into(),
        title: format!("Test {id}"),
        description: None,
        status: IssueStatus::Todo,
        priority: "none".into(),
        assignee_id: None,
        assignee_name: None,
        assignee_type: None,
        labels: vec![],
        parent_id: None,
        created_at: now,
        updated_at: now,
        created_by_id: "u".into(),
        created_by_name: "u".into(),
        created_by_type: "human".into(),
        blocked_by: vec![],
        blocking: vec![],
        session_ids: vec![],
        total_cost_usd: 0.0,
        total_tokens: 0,
        pr_numbers: vec![],
        content_hash: Some(id.into()),
        source_path: None,
        github_issue_number: None,
        github_url: None,
        start_date: None,
        due_date: None,
        acceptance_criteria: None,
    }
}

fn test_app() -> (axum::Router, Arc<SqliteStore>) {
    let duck = Arc::new(DuckDbStore::open(":memory:").expect("duckdb"));
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite"));

    let project = BoardProject {
        id: "GNT-project".into(),
        name: "GNT".into(),
        key: "GNT".into(),
        counter: 2,
        github_repo: None,
    };
    sqlite.create_board_project(&project).expect("create project");
    sqlite.insert_board_issue(&make_issue("GNT-project", "GNT-1")).unwrap();
    sqlite.insert_board_issue(&make_issue("GNT-project", "GNT-2")).unwrap();

    let router = create_router_dual(duck, Arc::clone(&sqlite));
    (router, sqlite)
}

async fn patch_json(app: &axum::Router, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("PATCH")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
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
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
}

#[tokio::test]
async fn schedule_sets_both_dates() {
    let (app, _) = test_app();
    let (status, body) = patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-01", "due_date": "2026-05-14" }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    assert_eq!(body["start_date"], "2026-05-01");
    assert_eq!(body["due_date"], "2026-05-14");
}

#[tokio::test]
async fn schedule_rejects_start_after_due() {
    let (app, _) = test_app();
    let (status, _) = patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-14", "due_date": "2026-05-01" }),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn schedule_rejects_bad_format() {
    let (app, _) = test_app();
    let (status, _) = patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "nope" }),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn schedule_null_clears_only_specified_field() {
    let (app, _) = test_app();
    patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-01", "due_date": "2026-05-14" }),
    )
    .await;

    let (status, body) = patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": null }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    assert!(
        body.get("start_date").map(|v| v.is_null()).unwrap_or(true),
        "start_date should be null/absent: {body}"
    );
    assert_eq!(body["due_date"], "2026-05-14");
}

#[tokio::test]
async fn schedule_rejects_empty_body() {
    let (app, _) = test_app();
    let (status, _) = patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn schedule_returns_404_for_missing_issue() {
    let (app, _) = test_app();
    let (status, _) = patch_json(
        &app,
        "/api/board/issues/NOPE-999/schedule",
        json!({ "start_date": "2026-05-01" }),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn schedule_emits_scheduled_event() {
    let (app, sqlite) = test_app();
    patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-01", "due_date": "2026-05-14" }),
    )
    .await;
    let events = sqlite.list_board_events("GNT-1").unwrap();
    let scheduled: Vec<_> = events.iter().filter(|e| e.event_type == "scheduled").collect();
    assert_eq!(scheduled.len(), 1, "expected one scheduled event, got {:?}", events);
    assert_eq!(scheduled[0].data["start_date"], "2026-05-01");
    assert_eq!(scheduled[0].data["due_date"], "2026-05-14");
}

#[tokio::test]
async fn gantt_returns_raw_range_over_scheduled() {
    let (app, _) = test_app();
    patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-01", "due_date": "2026-05-10" }),
    )
    .await;
    patch_json(
        &app,
        "/api/board/issues/GNT-2/schedule",
        json!({ "start_date": "2026-06-01", "due_date": "2026-06-15" }),
    )
    .await;

    let (status, body) = get_json(&app, "/api/board/projects/GNT-project/gantt").await;
    assert_eq!(status, 200, "body: {body}");
    assert_eq!(body["range"]["min"], "2026-05-01");
    assert_eq!(body["range"]["max"], "2026-06-15");
    assert_eq!(body["issues"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn gantt_returns_unscheduled_with_null_dates() {
    let (app, _) = test_app();
    let (status, body) = get_json(&app, "/api/board/projects/GNT-project/gantt").await;
    assert_eq!(status, 200, "body: {body}");
    assert!(body["range"]["min"].is_null());
    assert!(body["range"]["max"].is_null());
    let issues = body["issues"].as_array().unwrap();
    assert_eq!(issues.len(), 2);
    for i in issues {
        assert!(i["start_date"].is_null());
        assert!(i["due_date"].is_null());
    }
}

#[tokio::test]
async fn gantt_returns_404_for_missing_project() {
    let (app, _) = test_app();
    let (status, _) = get_json(&app, "/api/board/projects/nonexistent/gantt").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn gantt_mixes_scheduled_and_unscheduled() {
    let (app, _) = test_app();
    patch_json(
        &app,
        "/api/board/issues/GNT-1/schedule",
        json!({ "start_date": "2026-05-05", "due_date": "2026-05-09" }),
    )
    .await;

    let (status, body) = get_json(&app, "/api/board/projects/GNT-project/gantt").await;
    assert_eq!(status, 200, "body: {body}");
    assert_eq!(body["range"]["min"], "2026-05-05");
    assert_eq!(body["range"]["max"], "2026-05-09");
    let issues = body["issues"].as_array().unwrap();
    assert_eq!(issues.len(), 2);
    let unscheduled_count = issues.iter().filter(|i| i["start_date"].is_null()).count();
    assert_eq!(unscheduled_count, 1);
}
