//! Tests for the orchestrator-side primitives on `SqliteStore`:
//! `try_transition_claim` (atomic CAS) and `list_dispatchable_tasks`
//! (the worker's poll query).
//!
//! The CAS mirrors `KernelSpec.Orchestrator.step` — we don't re-verify the
//! state machine here (Lean does that), but we exercise the boundary where
//! two workers race for the same `Unclaimed → Claimed` transition.

use chrono::Utc;
use gctrl_core::{BoardIssue, BoardProject, IssueStatus, Task};
use gctrl_storage::SqliteStore;

fn test_store() -> SqliteStore {
    SqliteStore::open(":memory:").expect("open :memory: store")
}

fn seed_project(store: &SqliteStore, key: &str) {
    let project = BoardProject {
        id: format!("{key}-project"),
        name: key.into(),
        key: key.into(),
        counter: 1,
        github_repo: None,
    };
    store.create_board_project(&project).expect("create project");
}

fn seed_issue(
    store: &SqliteStore,
    key: &str,
    id: &str,
    status: IssueStatus,
    assignee_type: Option<&str>,
) {
    let now = Utc::now();
    let issue = BoardIssue {
        id: id.into(),
        project_id: format!("{key}-project"),
        title: format!("Seed {id}"),
        description: None,
        status,
        priority: "none".into(),
        assignee_id: assignee_type.map(|_| "agent:claude".into()),
        assignee_name: assignee_type.map(|_| "Claude".into()),
        assignee_type: assignee_type.map(str::to_string),
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
    };
    store.insert_board_issue(&issue).expect("insert issue");
}

#[test]
fn try_transition_claim_succeeds_from_expected_state() {
    let store = test_store();
    seed_project(&store, "BACK");
    seed_issue(&store, "BACK", "BACK-1", IssueStatus::InProgress, Some("agent"));
    let task = store.promote_issue_to_task("BACK-1", "claude-code").unwrap();

    let ok = store
        .try_transition_claim(
            &task.id,
            Task::CLAIM_UNCLAIMED,
            Task::CLAIM_CLAIMED,
        )
        .unwrap();
    assert!(ok, "CAS should succeed when row is in expected state");

    let tasks = store.list_tasks_for_issue("BACK-1").unwrap();
    assert_eq!(tasks[0].orchestrator_claim, Task::CLAIM_CLAIMED);
}

#[test]
fn try_transition_claim_fails_when_already_moved() {
    // Simulates the race: worker A wins the CAS, worker B's CAS now fails
    // because `from` no longer matches. No spurious double-dispatch.
    let store = test_store();
    seed_project(&store, "BACK");
    seed_issue(&store, "BACK", "BACK-1", IssueStatus::InProgress, Some("agent"));
    let task = store.promote_issue_to_task("BACK-1", "claude-code").unwrap();

    let a = store
        .try_transition_claim(&task.id, Task::CLAIM_UNCLAIMED, Task::CLAIM_CLAIMED)
        .unwrap();
    let b = store
        .try_transition_claim(&task.id, Task::CLAIM_UNCLAIMED, Task::CLAIM_CLAIMED)
        .unwrap();
    assert!(a);
    assert!(!b, "second CAS from same `from` state must fail");
}

#[test]
fn try_transition_claim_missing_task_returns_false() {
    let store = test_store();
    let ok = store
        .try_transition_claim("GHOST-1.T1", Task::CLAIM_UNCLAIMED, Task::CLAIM_CLAIMED)
        .unwrap();
    assert!(!ok);
}

#[test]
fn list_dispatchable_tasks_filters_by_status_and_assignee() {
    let store = test_store();
    seed_project(&store, "BACK");

    // Eligible: in_progress + agent assignee → promoted task.
    seed_issue(&store, "BACK", "BACK-1", IssueStatus::InProgress, Some("agent"));
    store.promote_issue_to_task("BACK-1", "claude-code").unwrap();

    // Ineligible: wrong status.
    seed_issue(&store, "BACK", "BACK-2", IssueStatus::Todo, Some("agent"));
    store.promote_issue_to_task("BACK-2", "claude-code").unwrap();

    // Ineligible: human assignee.
    seed_issue(&store, "BACK", "BACK-3", IssueStatus::InProgress, Some("human"));
    store.promote_issue_to_task("BACK-3", "claude-code").unwrap();

    // Ineligible: no assignee at all.
    seed_issue(&store, "BACK", "BACK-4", IssueStatus::InProgress, None);
    store.promote_issue_to_task("BACK-4", "claude-code").unwrap();

    let dispatchable = store.list_dispatchable_tasks(10).unwrap();
    assert_eq!(dispatchable.len(), 1);
    assert_eq!(dispatchable[0].issue_id.as_deref(), Some("BACK-1"));
}

#[test]
fn list_dispatchable_tasks_excludes_already_claimed() {
    let store = test_store();
    seed_project(&store, "BACK");
    seed_issue(&store, "BACK", "BACK-1", IssueStatus::InProgress, Some("agent"));
    let task = store.promote_issue_to_task("BACK-1", "claude-code").unwrap();

    store
        .try_transition_claim(&task.id, Task::CLAIM_UNCLAIMED, Task::CLAIM_CLAIMED)
        .unwrap();

    let dispatchable = store.list_dispatchable_tasks(10).unwrap();
    assert!(dispatchable.is_empty(), "claimed tasks must drop out of the queue");
}
