//! End-to-end worker test — uses `/bin/cat` as the stand-in agent so CI
//! doesn't need `claude` on the PATH. Drives the full Lean-verified
//! transition chain `Unclaimed → Claimed → Running → Released`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use gctrl_core::{BoardComment, BoardIssue, BoardProject, IssueStatus, Task};
use gctrl_orch::{DispatchOutcome, OrchConfig, Worker};
use gctrl_storage::SqliteStore;

fn seed_dispatchable_issue(store: &SqliteStore, issue_id: &str) -> Task {
    let project = BoardProject {
        id: "p".into(),
        name: "Back".into(),
        key: "BACK".into(),
        counter: 1,
        github_repo: None,
    };
    store.create_board_project(&project).unwrap();

    let now = Utc::now();
    let issue = BoardIssue {
        id: issue_id.into(),
        project_id: "p".into(),
        title: "Test dispatch".into(),
        description: Some("run the echo agent".into()),
        status: IssueStatus::InProgress,
        priority: "none".into(),
        assignee_id: Some("agent:claude".into()),
        assignee_name: Some("Claude".into()),
        assignee_type: Some("agent".into()),
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
        content_hash: None,
        source_path: None,
        github_issue_number: None,
        github_url: None,
    };
    store.insert_board_issue(&issue).unwrap();

    // Simulate the board UI's dispatch comment so prompt::build_prompt
    // picks it up.
    let comment = BoardComment {
        id: "c1".into(),
        issue_id: issue_id.into(),
        author_id: "board".into(),
        author_name: "Board".into(),
        author_type: "agent".into(),
        body: "## Agent: Engineer\nDo the thing.".into(),
        created_at: now,
        session_id: None,
    };
    store.insert_board_comment(&comment).unwrap();

    store.promote_issue_to_task(issue_id, "claude-code").unwrap()
}

fn cat_config() -> OrchConfig {
    OrchConfig {
        agent_cmd: vec!["cat".into()],
        working_dir: std::env::current_dir().unwrap(),
        poll_interval: Duration::from_millis(10),
        max_concurrent: 4,
        task_timeout: Duration::from_secs(5),
        dry_run: false,
    }
}

#[tokio::test]
async fn full_cycle_unclaimed_to_released() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-1");

    let worker = Worker::new(Arc::clone(&store), cat_config());
    let outcomes = worker.run_once().await.unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0],
        DispatchOutcome::Released {
            task_id: task.id.clone()
        }
    );

    let tasks = store.list_tasks_for_issue("BACK-1").unwrap();
    assert_eq!(tasks[0].orchestrator_claim, Task::CLAIM_RELEASED);

    // Worker posted a completion comment in addition to the seed dispatch.
    let comments = store.list_board_comments("BACK-1").unwrap();
    assert!(
        comments.iter().any(|c| c.author_id == "orch"),
        "expected orch completion comment, got {:?}",
        comments.iter().map(|c| &c.author_id).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn failing_agent_transitions_to_retry_queued() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-2");

    let mut config = cat_config();
    config.agent_cmd = vec!["sh".into(), "-c".into(), "exit 1".into()];
    let worker = Worker::new(Arc::clone(&store), config);

    let outcomes = worker.run_once().await.unwrap();
    assert_eq!(
        outcomes[0],
        DispatchOutcome::Retried {
            task_id: task.id.clone()
        }
    );
    let tasks = store.list_tasks_for_issue("BACK-2").unwrap();
    assert_eq!(tasks[0].orchestrator_claim, Task::CLAIM_RETRY_QUEUED);
}

#[tokio::test]
async fn second_worker_loses_race() {
    // Pre-claim the task so the worker's CAS loses.
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-3");
    // Simulate worker A's CAS by moving the task out of Unclaimed before
    // calling run_once. list_dispatchable_tasks won't return it, but we
    // force the race by constructing the task manually.
    store
        .try_transition_claim(&task.id, Task::CLAIM_UNCLAIMED, Task::CLAIM_CLAIMED)
        .unwrap();

    let worker = Worker::new(Arc::clone(&store), cat_config());
    let outcomes = worker.run_once().await.unwrap();
    assert!(
        outcomes.is_empty(),
        "already-claimed tasks must not appear in the poll result"
    );

    let tasks = store.list_tasks_for_issue("BACK-3").unwrap();
    assert_eq!(
        tasks[0].orchestrator_claim,
        Task::CLAIM_CLAIMED,
        "claim must be untouched"
    );
}

#[tokio::test]
async fn dry_run_releases_without_spawning() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-4");

    let mut config = cat_config();
    config.dry_run = true;
    config.agent_cmd = vec!["this-binary-does-not-exist".into()];
    let worker = Worker::new(Arc::clone(&store), config);

    let outcomes = worker.run_once().await.unwrap();
    assert_eq!(
        outcomes[0],
        DispatchOutcome::DryRun {
            task_id: task.id.clone()
        }
    );

    let tasks = store.list_tasks_for_issue("BACK-4").unwrap();
    assert_eq!(tasks[0].orchestrator_claim, Task::CLAIM_RELEASED);

    // No completion comment in dry-run mode.
    let comments = store.list_board_comments("BACK-4").unwrap();
    assert!(comments.iter().all(|c| c.author_id != "orch"));
}
