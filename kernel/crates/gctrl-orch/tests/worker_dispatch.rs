//! End-to-end worker test — uses `/bin/cat` as the stand-in agent so CI
//! doesn't need `claude` on the PATH. Drives the full Lean-verified
//! transition chain `Unclaimed → Claimed → Running → Released`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use gctrl_core::{BoardComment, BoardIssue, BoardProject, IssueStatus, OrchTask};
use gctrl_orch::{DispatchOutcome, OrchConfig, Worker};
use gctrl_storage::SqliteStore;

fn seed_dispatchable_issue(store: &SqliteStore, issue_id: &str) -> OrchTask {
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
        start_date: None,
        due_date: None,
        acceptance_criteria: None,
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

    store
        .promote_issue_to_task(issue_id, "claude-code")
        .unwrap()
}

fn cat_config() -> OrchConfig {
    OrchConfig {
        agent_cmd: vec!["cat".into()],
        working_dir: std::env::current_dir().unwrap(),
        env_passthrough: vec![],
        poll_interval: Duration::from_millis(10),
        max_per_pass: 4,
        task_timeout: Duration::from_secs(5),
        dry_run: false,
        kernel_base_url: "http://127.0.0.1:4318".into(),
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
    assert_eq!(tasks[0].orchestrator_claim, OrchTask::CLAIM_RELEASED);

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
    assert_eq!(tasks[0].orchestrator_claim, OrchTask::CLAIM_RETRY_QUEUED);
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
        .try_transition_claim(&task.id, OrchTask::CLAIM_UNCLAIMED, OrchTask::CLAIM_CLAIMED)
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
        OrchTask::CLAIM_CLAIMED,
        "claim must be untouched"
    );
}

#[tokio::test]
async fn dry_run_returns_task_to_unclaimed() {
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

    // Dry-run is non-destructive: the task lands back in Unclaimed so a
    // real run can pick it up without re-promoting the issue.
    let tasks = store.list_tasks_for_issue("BACK-4").unwrap();
    assert_eq!(tasks[0].orchestrator_claim, OrchTask::CLAIM_UNCLAIMED);

    // No completion comment in dry-run mode.
    let comments = store.list_board_comments("BACK-4").unwrap();
    assert!(comments.iter().all(|c| c.author_id != "orch"));
}

#[tokio::test]
async fn spawn_failure_transitions_to_released_not_retry() {
    // Lean spec: `dispatchFailed` is Claimed→Released (not Claimed→RetryQueued).
    // Verifies the split-phase spawn/await fix.
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-5");

    let mut config = cat_config();
    config.agent_cmd = vec!["this-binary-does-not-exist-12345".into()];
    let worker = Worker::new(Arc::clone(&store), config);

    let outcomes = worker.run_once().await.unwrap();
    assert_eq!(
        outcomes[0],
        DispatchOutcome::Retried {
            task_id: task.id.clone()
        }
    );

    let tasks = store.list_tasks_for_issue("BACK-5").unwrap();
    assert_eq!(
        tasks[0].orchestrator_claim,
        OrchTask::CLAIM_RELEASED,
        "spawn failure must land on Released per dispatchFailed; got {}",
        tasks[0].orchestrator_claim
    );
}

use gctrl_core::compute::*;
use gctrl_orch::ComputeWorker;
use gctrl_storage::DuckDbStore;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

struct ScriptedCompute {
    invocation: Mutex<Option<ComputeInvocation>>,
    phase: Mutex<ComputePhase>,
    launches: AtomicUsize,
    reconciles: AtomicUsize,
    cancels: AtomicUsize,
    lose_cancel: AtomicBool,
    pause_launch: AtomicBool,
    started: tokio::sync::Notify,
}
impl ScriptedCompute {
    fn new() -> Self {
        Self {
            invocation: Mutex::new(None),
            phase: Mutex::new(ComputePhase::Running),
            launches: AtomicUsize::new(0),
            reconciles: AtomicUsize::new(0),
            cancels: AtomicUsize::new(0),
            lose_cancel: AtomicBool::new(true),
            pause_launch: AtomicBool::new(false),
            started: tokio::sync::Notify::new(),
        }
    }
    fn receipt(&self) -> ComputeSnapshot {
        let invocation = self.invocation.lock().unwrap().clone().unwrap();
        let phase = *self.phase.lock().unwrap();
        ComputeSnapshot {
            attempt_id: invocation.attempt_id.clone(),
            invocation_hash: Some(invocation.fingerprint().unwrap()),
            host_id: "actual-machine:boot".into(),
            process_incarnation: Some("actual-machine:boot:pid:start".into()),
            phase,
            exit_code: (phase == ComputePhase::Exited).then_some(0),
            stdout: "verified remote result".into(),
            stderr: String::new(),
            detail: None,
        }
    }
}
#[async_trait::async_trait]
impl ComputeSubstrate for ScriptedCompute {
    fn environment_id(&self) -> &str {
        "remote"
    }
    async fn launch(
        &self,
        invocation: &ComputeInvocation,
    ) -> Result<ComputeSnapshot, ComputeError> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        *self.invocation.lock().unwrap() = Some(invocation.clone());
        self.started.notify_one();
        if self.pause_launch.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        Err(ComputeError::Uncertain {
            detail: "SSH acknowledgment lost after dispatch".into(),
        })
    }
    async fn reconcile(&self, _: &str) -> Result<ComputeSnapshot, ComputeError> {
        self.reconciles.fetch_add(1, Ordering::SeqCst);
        Ok(self.receipt())
    }
    async fn cancel(&self, _: &str) -> Result<ComputeSnapshot, ComputeError> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        if self.lose_cancel.load(Ordering::SeqCst) {
            Err(ComputeError::Uncertain {
                detail: "cancel acknowledgment lost".into(),
            })
        } else {
            *self.phase.lock().unwrap() = ComputePhase::Cancelled;
            Ok(self.receipt())
        }
    }
}
fn compute_config() -> ComputeWorkerConfig {
    ComputeWorkerConfig {
        workspace_id: "worktree".into(),
        environment_id: "remote".into(),
        agent_command: vec!["/bin/cat".into()],
        cwd: "/target/worktree".into(),
        env: std::collections::BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        timeout_seconds: 30,
        max_per_pass: 4,
        kernel_base_url: "http://kernel.test:4318".into(),
    }
}
#[test]
fn task_lookup_returns_the_actual_claim_and_never_creates_a_caller_supplied_task() {
    let store = SqliteStore::open(":memory:").unwrap();
    let task = seed_dispatchable_issue(&store, "BACK-COMPUTE");
    assert_eq!(store.get_orch_task(&task.id).unwrap(), Some(task));
    assert!(store.get_orch_task("forged-task").unwrap().is_none());
}
#[tokio::test]
async fn durable_compute_worker_recovers_the_prior_attempt_and_acknowledges_completion_after_claim()
{
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-REMOTE");
    let ledger = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let compute = Arc::new(ScriptedCompute::new());
    let worker = ComputeWorker::new(
        store.clone(),
        ledger.clone(),
        compute.clone(),
        compute_config(),
    )
    .unwrap();
    assert_eq!(worker.run_once().await.unwrap().len(), 1);
    let intent = ledger.unsettled().unwrap().pop().unwrap();
    assert_eq!(intent.invocation.task_id, task.id);
    assert_eq!(intent.invocation.workspace_id, "worktree");
    assert_eq!(intent.phase, ComputePhase::Uncertain);
    assert_eq!(
        store
            .get_orch_task(&task.id)
            .unwrap()
            .unwrap()
            .orchestrator_claim,
        OrchTask::CLAIM_CLAIMED
    );
    let session = ledger
        .get_session(&gctrl_core::SessionId(
            intent.invocation.agent_session_id.clone(),
        ))
        .unwrap()
        .unwrap();
    assert_eq!(session.created_by, gctrl_core::CreatedBy::Scheduler);
    assert_eq!(session.workspace_id.0, "worktree");
    assert!(!intent.invocation.env.contains_key("HOME"));
    assert_eq!(intent.invocation.env["GCTRL_TASK_ID"], task.id);
    drop(worker);
    let restarted = ComputeWorker::new(
        store.clone(),
        ledger.clone(),
        compute.clone(),
        compute_config(),
    )
    .unwrap();
    assert_eq!(restarted.run_once().await.unwrap().len(), 1);
    assert_eq!(
        compute.launches.load(Ordering::SeqCst),
        1,
        "restart must reconcile, not relaunch"
    );
    assert_eq!(
        store
            .get_orch_task(&task.id)
            .unwrap()
            .unwrap()
            .orchestrator_claim,
        OrchTask::CLAIM_RUNNING
    );
    *compute.phase.lock().unwrap() = ComputePhase::Exited;
    assert_eq!(
        restarted.run_once().await.unwrap(),
        vec![DispatchOutcome::Released {
            task_id: task.id.clone()
        }]
    );
    assert!(ledger.unsettled().unwrap().is_empty());
    assert_eq!(
        store
            .get_orch_task(&task.id)
            .unwrap()
            .unwrap()
            .orchestrator_claim,
        OrchTask::CLAIM_RELEASED
    );
    assert!(restarted.run_once().await.unwrap().is_empty());
    assert_eq!(compute.launches.load(Ordering::SeqCst), 1);
    let completions: Vec<_> = store
        .list_board_comments("BACK-REMOTE")
        .unwrap()
        .into_iter()
        .filter(|c| c.author_id == "orch")
        .collect();
    assert_eq!(completions.len(), 1);
    assert_eq!(
        completions[0].session_id.as_deref(),
        Some(session.id.0.as_str())
    );
}
#[tokio::test]
async fn durable_compute_worker_retries_requested_cancel_after_restart_without_relaunch() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-CANCEL");
    let ledger = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let compute = Arc::new(ScriptedCompute::new());
    let worker = ComputeWorker::new(
        store.clone(),
        ledger.clone(),
        compute.clone(),
        compute_config(),
    )
    .unwrap();
    worker.run_once().await.unwrap();
    let id = ledger.unsettled().unwrap()[0].invocation.attempt_id.clone();
    let requested = worker.cancel(&id).await.unwrap();
    assert!(requested.cancellation_requested);
    assert!(!matches!(
        requested.phase,
        ComputePhase::Cancelled | ComputePhase::Exited
    ));
    drop(worker);
    let worker = ComputeWorker::new(
        store.clone(),
        ledger.clone(),
        compute.clone(),
        compute_config(),
    )
    .unwrap();
    worker.run_once().await.unwrap();
    assert_eq!(compute.cancels.load(Ordering::SeqCst), 2);
    assert_eq!(compute.reconciles.load(Ordering::SeqCst), 0);
    compute.lose_cancel.store(false, Ordering::SeqCst);
    worker.run_once().await.unwrap();
    assert!(ledger.unsettled().unwrap().is_empty());
    let invocation = compute.invocation.lock().unwrap().clone().unwrap();
    let session = ledger
        .get_session(&gctrl_core::SessionId(invocation.agent_session_id))
        .unwrap()
        .unwrap();
    assert_eq!(session.status, gctrl_core::SessionStatus::Cancelled);
    assert!(session.ended_at.is_some());
    assert_eq!(compute.launches.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .get_orch_task(&task.id)
            .unwrap()
            .unwrap()
            .orchestrator_claim,
        OrchTask::CLAIM_RETRY_QUEUED
    );
    assert!(matches!(
        worker.cancel("forged-attempt").await,
        Err(ComputeError::NotFound { .. })
    ));
    assert_eq!(compute.cancels.load(Ordering::SeqCst), 3);
}
#[tokio::test]
async fn durable_compute_worker_aborted_dispatch_retains_its_attempt_for_reconciliation() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let task = seed_dispatchable_issue(&store, "BACK-ABORT");
    let ledger = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let compute = Arc::new(ScriptedCompute::new());
    compute.pause_launch.store(true, Ordering::SeqCst);
    let worker = Arc::new(
        ComputeWorker::new(
            store.clone(),
            ledger.clone(),
            compute.clone(),
            compute_config(),
        )
        .unwrap(),
    );
    let running = tokio::spawn(async move { worker.run_once().await });
    tokio::time::timeout(Duration::from_secs(2), compute.started.notified())
        .await
        .unwrap();
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_eq!(
        ledger.unsettled().unwrap()[0].phase,
        ComputePhase::Uncertain
    );
    let restarted = ComputeWorker::new(
        store.clone(),
        ledger.clone(),
        compute.clone(),
        compute_config(),
    )
    .unwrap();
    restarted.run_once().await.unwrap();
    assert_eq!(compute.launches.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .get_orch_task(&task.id)
            .unwrap()
            .unwrap()
            .orchestrator_claim,
        OrchTask::CLAIM_RUNNING
    );
}

#[tokio::test]
async fn durable_compute_worker_finishes_terminal_receipts_after_a_crash_before_or_after_claim_update(
) {
    for already_transitioned in [false, true] {
        let store = Arc::new(SqliteStore::open(":memory:").unwrap());
        let task = seed_dispatchable_issue(&store, "BACK-FINISH");
        let ledger = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let compute = Arc::new(ScriptedCompute::new());
        let worker = ComputeWorker::new(
            store.clone(),
            ledger.clone(),
            compute.clone(),
            compute_config(),
        )
        .unwrap();
        worker.run_once().await.unwrap();
        worker.run_once().await.unwrap();
        *compute.phase.lock().unwrap() = ComputePhase::Exited;
        ledger.record(&compute.receipt()).unwrap();
        assert_eq!(ledger.unsettled().unwrap().len(), 1);
        if already_transitioned {
            store
                .try_transition_claim(&task.id, OrchTask::CLAIM_RUNNING, OrchTask::CLAIM_RELEASED)
                .unwrap();
        }
        drop(worker);
        let worker = ComputeWorker::new(
            store.clone(),
            ledger.clone(),
            compute.clone(),
            compute_config(),
        )
        .unwrap();
        assert_eq!(
            worker.run_once().await.unwrap(),
            vec![DispatchOutcome::Released {
                task_id: task.id.clone()
            }]
        );
        assert_eq!(
            compute.reconciles.load(Ordering::SeqCst),
            1,
            "terminal receipt must be imported without another target call"
        );
        assert_eq!(compute.launches.load(Ordering::SeqCst), 1);
        assert!(ledger.unsettled().unwrap().is_empty());
        assert!(worker.run_once().await.unwrap().is_empty());
        assert_eq!(
            store
                .list_board_comments("BACK-FINISH")
                .unwrap()
                .iter()
                .filter(|c| c.author_id == "orch")
                .count(),
            1
        );
    }
}
#[test]
fn durable_compute_worker_requires_explicit_target_paths_and_the_selected_environment() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let ledger = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let compute = Arc::new(ScriptedCompute::new());
    let mut invalid = compute_config();
    invalid.environment_id = "wrong-host".into();
    assert!(matches!(
        ComputeWorker::new(store.clone(), ledger.clone(), compute.clone(), invalid),
        Err(ComputeError::Invalid { .. })
    ));
    let mut invalid = compute_config();
    invalid.agent_command.clear();
    assert!(matches!(
        ComputeWorker::new(store.clone(), ledger.clone(), compute.clone(), invalid),
        Err(ComputeError::Invalid { .. })
    ));
    let mut invalid = compute_config();
    invalid.cwd = "relative".into();
    assert!(matches!(
        ComputeWorker::new(store, ledger, compute, invalid),
        Err(ComputeError::Invalid { .. })
    ));
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable SSH host; mandatory remote worker acceptance gate"]
async fn live_ssh_worker_retains_actual_task_session_and_attempt_across_lost_dispatch_and_restart(
) -> Result<(), Box<dyn std::error::Error>> {
    use gctrl_compute::SshCompute;
    fn required(key: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| panic!("set {key} for the owned target"))
    }
    fn ensure(value: bool, detail: &str) -> Result<(), Box<dyn std::error::Error>> {
        if value {
            Ok(())
        } else {
            Err(std::io::Error::other(detail).into())
        }
    }
    let ssh_config = SshComputeConfig {
        environment_id: "remote".into(),
        ssh_alias: required("GCTRL_LIVE_SSH_ALIAS"),
        ssh_config: Some(required("GCTRL_LIVE_SSH_CONFIG").into()),
        python_path: "/usr/bin/python3".into(),
        helper_path: required("GCTRL_LIVE_COMPUTE_HELPER"),
        state_root: required("GCTRL_LIVE_COMPUTE_STATE"),
        cgroup_root: required("GCTRL_LIVE_COMPUTE_CGROUP"),
    };
    let compute = Arc::new(SshCompute::new(ssh_config.clone())?);
    let mut delayed = ssh_config;
    delayed.helper_path = required("GCTRL_LIVE_COMPUTE_DELAYED_HELPER");
    let delayed = Arc::new(SshCompute::new(delayed)?);
    let store = Arc::new(SqliteStore::open(":memory:")?);
    let task = seed_dispatchable_issue(&store, "BACK-SSH-WORKER");
    let ledger = Arc::new(DuckDbStore::open(":memory:")?);
    let marker = format!("worker-starts-{}", uuid::Uuid::new_v4());
    let mut config = compute_config();
    config.cwd = required("GCTRL_LIVE_COMPUTE_CWD");
    config.agent_command=vec!["/usr/bin/python3".into(),"-c".into(),format!("import os,time; from pathlib import Path; Path('{marker}').open('a').write('started\\n'); print(os.environ['GCTRL_TASK_ID'],os.environ['GCTRL_AGENT_SESSION_ID'],os.environ['GCTRL_WORKSPACE_ID'],flush=True); time.sleep(25)")];
    let mut owned_id = None;
    let result: Result<(),Box<dyn std::error::Error>> = async {
        let worker = ComputeWorker::new(store.clone(),ledger.clone(),delayed,config.clone())?;
        let outcomes = worker.run_once().await?;
        ensure(outcomes==vec![DispatchOutcome::AwaitingReconciliation {task_id:task.id.clone()}],"lost SSH dispatch must retain the claim")?;
        let attempt = ledger.unsettled()?.pop().ok_or_else(||std::io::Error::other("missing durable intent"))?;
        owned_id=Some(attempt.invocation.attempt_id.clone());
        ensure(attempt.phase==ComputePhase::Uncertain,"loss was incorrectly recorded as exit")?;
        ensure(store.get_orch_task(&task.id)?.unwrap().orchestrator_claim==OrchTask::CLAIM_CLAIMED,"loss released the claim")?;
        drop(worker);
        let restarted = ComputeWorker::new(store.clone(),ledger.clone(),compute.clone(),config)?;
        restarted.run_once().await?;
        let observed = ledger.unsettled()?.pop().unwrap();
        ensure(observed.invocation==attempt.invocation,"restart replaced the original invocation")?;
        let snapshot=observed.snapshot.as_ref().ok_or_else(||std::io::Error::other("no running target receipt"))?;
        ensure(snapshot.phase==ComputePhase::Running && snapshot.stdout.contains(&task.id) && snapshot.stdout.contains(&attempt.invocation.agent_session_id),"target did not execute within the actual kernel Task/Session")?;
        ensure(store.get_orch_task(&task.id)?.unwrap().orchestrator_claim==OrchTask::CLAIM_RUNNING,"running execution was not attached to the existing claim")?;
        ensure(restarted.cancel(&attempt.invocation.attempt_id).await?.phase==ComputePhase::Cancelled,"target recursive cancellation not confirmed")?;
        restarted.run_once().await?;
        ensure(ledger.unsettled()?.is_empty(),"confirmed completion was not acknowledged")?;
        ensure(store.get_orch_task(&task.id)?.unwrap().orchestrator_claim==OrchTask::CLAIM_RETRY_QUEUED,"cancelled execution did not follow existing retry states")?;
        ensure(restarted.run_once().await?.is_empty(),"restart/cancel dispatched a replacement")?;
        // Test instrumentation reads the owned target's marker through the same
        // substrate; the actual agent dispatch above owns the kernel claim.
        let mut probe=attempt.invocation;probe.attempt_id=uuid::Uuid::new_v4().to_string();
        probe.args=vec!["-c".into(),format!("from pathlib import Path; print(len(Path('{marker}').read_text().splitlines()),flush=True)")];
        compute.launch(&probe).await?;
        let deadline=std::time::Instant::now()+Duration::from_secs(5);
        loop {
            let result=compute.reconcile(&probe.attempt_id).await?;
            if result.phase==ComputePhase::Exited {ensure(result.exit_code==Some(0)&&result.stdout.trim()=="1","uncertain dispatch caused duplicate target execution")?;break;}
            ensure(std::time::Instant::now()<deadline,"marker verification did not complete")?;
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Ok(())
    }.await;
    if let Some(id) = owned_id {
        let cleanup = compute.cancel(&id).await;
        if result.is_ok() {
            ensure(
                cleanup?.phase == ComputePhase::Cancelled,
                "owned execution cleanup not confirmed",
            )?;
        }
    }
    result?;
    println!("SSH worker gate: actual claimed Task and kernel Session, durable lost-dispatch intent, same-attempt restart, exactly one target execution, recursive cancellation, existing claim transitions");
    Ok(())
}
