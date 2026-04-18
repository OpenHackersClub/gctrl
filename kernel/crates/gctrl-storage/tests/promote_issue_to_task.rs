//! TDD contract tests for Issue → Task promotion on status move.
//!
//! These tests are **intentionally ignored** and compile against only the
//! existing `SqliteStore` surface — they describe the contract from
//! [specs/implementation/kernel/session-trigger.md §Tier 1] that a follow-up
//! PR must satisfy.
//!
//! The implementer's job:
//!   1. Remove the `#[ignore]` attribute on each test.
//!   2. Implement `promote_issue_to_task` and `list_tasks_for_issue` on
//!      `SqliteStore` per the spec.
//!   3. Modify `update_board_issue_status` so that a transition to
//!      `in_progress` promotes the Issue to a Task in the same transaction.
//!   4. Replace each `unimplemented!()` below with the sketched assertions.
//!
//! Once the test panics turn into real assertions and those pass, commit.
//! No new public API is added in this PR — the spec alone lands first.

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
#[ignore = "TDD pending — requires SqliteStore::promote_issue_to_task + list_tasks_for_issue (see specs/implementation/kernel/session-trigger.md §Tier 1, Red 1)"]
fn promote_creates_single_task_for_unpromoted_issue() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-1");

    // let task = store.promote_issue_to_task("BACK-1", "claude-code").expect("promote");
    // assert_eq!(task.issue_id.as_deref(), Some("BACK-1"));
    // assert_eq!(task.agent_kind, "claude-code");
    // assert_eq!(task.orchestrator_claim, "Unclaimed");
    // assert_eq!(task.attempt, 0);

    // let tasks = store.list_tasks_for_issue("BACK-1").expect("list");
    // assert_eq!(tasks.len(), 1, "exactly one Task row should exist");

    unimplemented!(
        "Implement SqliteStore::promote_issue_to_task + list_tasks_for_issue, \
         then replace this panic with the commented assertions above."
    );
}

#[test]
#[ignore = "TDD pending — promote-or-reuse rule: repeated promotion must not duplicate (spec §Tier 1, Red 2)"]
fn promote_reuses_existing_nonterminal_task() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-2");

    // let first = store.promote_issue_to_task("BACK-2", "claude-code").expect("promote 1");
    // let second = store.promote_issue_to_task("BACK-2", "claude-code").expect("promote 2");
    // assert_eq!(first.id, second.id, "second promote must reuse the existing task");
    //
    // let tasks = store.list_tasks_for_issue("BACK-2").expect("list");
    // assert_eq!(tasks.len(), 1);

    unimplemented!(
        "Assert second promote returns the same Task id when the first Task is still non-terminal."
    );
}

#[test]
#[ignore = "TDD pending — moving Issue to in_progress must promote in the same transaction (spec §Tier 1, Red 3)"]
fn move_to_in_progress_promotes_linked_task() {
    let store = test_store();
    seed_project_and_issue(&store, "BACK", "BACK-3");

    store
        .update_board_issue_status("BACK-3", "in_progress", "actor-1", "Actor", "human")
        .expect("move");

    // let tasks = store.list_tasks_for_issue("BACK-3").expect("list");
    // assert_eq!(tasks.len(), 1, "moving to in_progress must auto-promote the Issue");
    // assert_eq!(tasks[0].orchestrator_claim, "Unclaimed");

    unimplemented!(
        "After implementation, uncomment the assertions — the move side-effect is \
         the primary trigger for board drag-to-dispatch."
    );
}
