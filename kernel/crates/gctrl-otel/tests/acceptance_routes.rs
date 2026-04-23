//! HTTP contract tests for the acceptance routes:
//!
//! - `POST /api/board/issues/{id}/acceptance/checks/{idx}` — agent callback
//! - `GET  /api/board/issues/{id}/acceptance` — rollup for the badge

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

fn make_issue(project_id: &str, id: &str, criteria: Option<&str>) -> BoardIssue {
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
        acceptance_criteria: criteria.map(String::from),
    }
}

fn test_app_with_criteria(criteria: Option<&str>) -> (axum::Router, Arc<SqliteStore>) {
    let duck = Arc::new(DuckDbStore::open(":memory:").expect("duckdb"));
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite"));

    let project = BoardProject {
        id: "BACK-project".into(),
        name: "BACK".into(),
        key: "BACK".into(),
        counter: 1,
        github_repo: None,
    };
    sqlite.create_board_project(&project).expect("project");
    sqlite
        .insert_board_issue(&make_issue("BACK-project", "BACK-42", criteria))
        .expect("issue");
    let router = create_router_dual(duck, Arc::clone(&sqlite));
    (router, sqlite)
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

async fn promote(app: &axum::Router, id: &str) {
    let (status, body) = post_json(
        app,
        &format!("/api/board/issues/{id}/move"),
        json!({"status":"in_progress","actor_id":"u","actor_name":"User"}),
    )
    .await;
    assert_eq!(status, 200, "promote failed: {body}");
}

#[tokio::test]
async fn rollup_is_empty_when_issue_has_no_criteria() {
    let (app, _sqlite) = test_app_with_criteria(None);
    let (status, body) = get_json(&app, "/api/board/issues/BACK-42/acceptance").await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], 0);
    assert_eq!(body["passed"], 0);
    assert_eq!(body["checks"].as_array().map(|a| a.len()), Some(0));
}

#[tokio::test]
async fn post_pass_updates_rollup() {
    let criteria = "\
- [ ] shell: curl :8080/health
- [ ] test: pnpm test
";
    let (app, _sqlite) = test_app_with_criteria(Some(criteria));
    promote(&app, "BACK-42").await;

    let (status, _body) = post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/0",
        json!({"status":"pass","output":"HTTP/1.1 200 OK"}),
    )
    .await;
    assert_eq!(status, 200);

    let (status, body) = get_json(&app, "/api/board/issues/BACK-42/acceptance").await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], 2);
    assert_eq!(body["passed"], 1);
    assert_eq!(body["pending"], 1);
    assert_eq!(body["checks"][0]["status"], "pass");
    assert_eq!(body["checks"][0]["output"], "HTTP/1.1 200 OK");
}

#[tokio::test]
async fn post_rejects_invalid_status_with_400() {
    let criteria = "- [ ] shell: echo";
    let (app, _sqlite) = test_app_with_criteria(Some(criteria));
    promote(&app, "BACK-42").await;

    let (status, _body) = post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/0",
        json!({"status":"maybe"}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn post_returns_404_for_unknown_idx() {
    let criteria = "- [ ] shell: echo";
    let (app, _sqlite) = test_app_with_criteria(Some(criteria));
    promote(&app, "BACK-42").await;

    let (status, _body) = post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/99",
        json!({"status":"pass"}),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn rollup_mixed_statuses_match_counts() {
    let criteria = "\
- [ ] shell: a
- [ ] shell: b
- [ ] shell: c
- [ ] shell: d
";
    let (app, _sqlite) = test_app_with_criteria(Some(criteria));
    promote(&app, "BACK-42").await;
    post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/0",
        json!({"status":"pass"}),
    )
    .await;
    post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/1",
        json!({"status":"pass"}),
    )
    .await;
    post_json(
        &app,
        "/api/board/issues/BACK-42/acceptance/checks/2",
        json!({"status":"fail","output":"boom"}),
    )
    .await;
    // idx 3 left as pending.

    let (_, body) = get_json(&app, "/api/board/issues/BACK-42/acceptance").await;
    assert_eq!(body["total"], 4);
    assert_eq!(body["passed"], 2);
    assert_eq!(body["failed"], 1);
    assert_eq!(body["pending"], 1);
}
