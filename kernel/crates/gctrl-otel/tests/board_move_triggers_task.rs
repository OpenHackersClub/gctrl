//! Tier 2 integration tests: HTTP side-effects on `POST /api/board/issues/:id/move`.
//!
//! Response envelope contract (from
//! specs/architecture/session-trigger-from-board.md §HTTP):
//!
//! ```json
//! { "issue": { ... }, "task_id": "TASK-...", "dispatched": true }
//! ```
//!
//! - Moving to `in_progress` auto-promotes the Issue to a Task in the same
//!   transaction and returns `dispatched: true` + `task_id`.
//! - Any other transition leaves `task_id: null` and `dispatched: false`.

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
    }
}

fn test_app() -> (axum::Router, Arc<SqliteStore>) {
    let duck = Arc::new(DuckDbStore::open(":memory:").expect("duckdb"));
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite"));

    let project = BoardProject {
        id: "BACK-project".into(),
        name: "BACK".into(),
        key: "BACK".into(),
        counter: 1,
        github_repo: None,
    };
    sqlite.create_board_project(&project).expect("create project");
    sqlite
        .insert_board_issue(&make_issue("BACK-project", "BACK-42"))
        .expect("insert issue");

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
    let json_body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json_body)
}

#[tokio::test]
async fn move_to_in_progress_returns_task_id_and_dispatched_true() {
    let (app, sqlite) = test_app();

    let (status, body) = post_json(
        &app,
        "/api/board/issues/BACK-42/move",
        json!({
            "status": "in_progress",
            "actor_id": "u",
            "actor_name": "User",
        }),
    )
    .await;

    assert_eq!(status, 200, "body: {body}");
    assert_eq!(
        body["dispatched"],
        Value::Bool(true),
        "body missing `dispatched: true`: {body}"
    );
    let task_id = body["task_id"]
        .as_str()
        .unwrap_or_else(|| panic!("task_id missing: {body}"));
    assert!(task_id.starts_with("TASK-"), "got: {task_id}");

    assert_eq!(body["issue"]["id"], "BACK-42");
    assert_eq!(body["issue"]["status"], "in_progress");

    let tasks = sqlite.list_tasks_for_issue("BACK-42").unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, task_id);
}

#[tokio::test]
async fn move_to_backlog_does_not_promote() {
    let (app, sqlite) = test_app();

    let (status, body) = post_json(
        &app,
        "/api/board/issues/BACK-42/move",
        json!({
            "status": "backlog",
            "actor_id": "u",
            "actor_name": "User",
        }),
    )
    .await;

    assert_eq!(status, 200, "body: {body}");
    assert_eq!(body["dispatched"], Value::Bool(false));
    assert!(
        body.get("task_id").map(|v| v.is_null()).unwrap_or(true),
        "task_id should be null/absent: {body}"
    );
    assert_eq!(body["issue"]["status"], "backlog");

    let tasks = sqlite.list_tasks_for_issue("BACK-42").unwrap();
    assert!(tasks.is_empty());
}
