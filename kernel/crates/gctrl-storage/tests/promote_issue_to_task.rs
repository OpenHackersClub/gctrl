//! TDD contract tests for Issue → Task promotion on status move.
//!
//! These tests describe the contract from
//! [specs/implementation/kernel/session-trigger.md §Tier 1] that `SqliteStore`
//! must satisfy. They are the RED half of the red-green cycle: they reference
//! `promote_issue_to_task` and `list_tasks_for_issue`, which do not yet exist
//! on `SqliteStore`. Expect a compile error until Tier 1 GREEN lands.

use chrono::Utc;
use gctrl_core::{BoardIssue, BoardProject, IssueStatus};
use gctrl_storage::SqliteStore;

fn test_store() -> SqliteStore {
    SqliteStore::open(":memory:").expect("open :memory: store")
}

fn seed_project_and_issue(store: &SqliteStore, key: &str, issue_id: &str) {
    let project = BoardProject {
        id: format!("{key}-project"),
        name: key.into(),
        key: key.into(),
        counter: 1,
        github_repo: None,
    };
    store.create_board_project(&project).expect("create project");

    let now = Utc::now();
    let issue = BoardIssue {
        id: issue_id.into(),
        project_id: project.id.clone(),
        title: format!("Seed {issue_id}"),
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
        content_hash: Some(issue_id.into()),
        source_path: None,
        github_issue_number: None,
        github_url: None,
    };
    store.insert_board_issue(&issue).expect("insert issue");
}

#[test]
fn promote_creates_single_task_for_unpromoted_issue() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-1");

    let task = store
        .promote_issue_to_task("BACK-1", "claude-code")
        .expect("promote");
    assert_eq!(task.id, "BACK-1.T1", "task id must be <ISSUE_ID>.T<N>, starting at 1");
    assert_eq!(task.issue_id.as_deref(), Some("BACK-1"));
    assert_eq!(task.attempt_ordinal, 1);
    assert_eq!(task.agent_kind, "claude-code");
    assert_eq!(task.orchestrator_claim, "Unclaimed");
    assert_eq!(task.attempt, 0);

    let tasks = store.list_tasks_for_issue("BACK-1").expect("list");
    assert_eq!(tasks.len(), 1, "exactly one Task row should exist");
}

#[test]
fn promote_reuses_existing_nonterminal_task() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-2");

    let first = store
        .promote_issue_to_task("BACK-2", "claude-code")
        .expect("promote 1");
    let second = store
        .promote_issue_to_task("BACK-2", "claude-code")
        .expect("promote 2");
    assert_eq!(
        first.id, second.id,
        "second promote must reuse the existing task while non-terminal"
    );

    let tasks = store.list_tasks_for_issue("BACK-2").expect("list");
    assert_eq!(tasks.len(), 1);
}

#[test]
fn move_to_in_progress_promotes_linked_task() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-3");

    let promoted = store
        .update_board_issue_status_and_promote(
            "BACK-3",
            "in_progress",
            "claude-code",
            "actor-1",
            "Actor",
            "human",
        )
        .expect("move");

    let task = promoted.expect("move to in_progress must return the promoted Task");
    assert_eq!(task.orchestrator_claim, "Unclaimed");
    assert_eq!(task.issue_id.as_deref(), Some("BACK-3"));
    assert_eq!(task.agent_kind, "claude-code");
    assert_eq!(task.id, "BACK-3.T1", "task id must be project-keyed <ISSUE_ID>.T<N>");
    assert_eq!(task.attempt_ordinal, 1);

    let tasks = store.list_tasks_for_issue("BACK-3").expect("list");
    assert_eq!(tasks.len(), 1);
}

#[test]
fn move_to_non_in_progress_does_not_promote() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-4");

    let promoted = store
        .update_board_issue_status_and_promote(
            "BACK-4",
            "backlog",
            "claude-code",
            "actor-1",
            "Actor",
            "human",
        )
        .expect("move");

    assert!(promoted.is_none(), "only in_progress transitions promote");
    let tasks = store.list_tasks_for_issue("BACK-4").expect("list");
    assert!(tasks.is_empty());
}

#[test]
fn promote_after_released_creates_new_task_with_next_ordinal() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-5");

    let first = store
        .promote_issue_to_task("BACK-5", "claude-code")
        .expect("promote 1");
    assert_eq!(first.id, "BACK-5.T1");
    assert_eq!(first.attempt_ordinal, 1);

    // Orchestrator finishes and releases the Task (terminal claim state).
    store
        .update_task_claim(&first.id, "Released")
        .expect("release");

    // Fresh drag: should mint a new Task with the next ordinal, not reuse.
    let second = store
        .promote_issue_to_task("BACK-5", "claude-code")
        .expect("promote 2");
    assert_ne!(first.id, second.id, "Released must not be reused");
    assert_eq!(second.id, "BACK-5.T2");
    assert_eq!(second.attempt_ordinal, 2);
    assert_eq!(second.orchestrator_claim, "Unclaimed");

    let tasks = store.list_tasks_for_issue("BACK-5").expect("list");
    assert_eq!(tasks.len(), 2, "audit history preserved across attempts");
}
