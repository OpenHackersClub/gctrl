//! Gather runs into one iTerm2 window on the active Space.
//! Contract: spec § Gather into a Space.
//!
//! A run moves by being resumed in a tab of the new window:
//!
//! 1. A run with no live process resumes directly.
//! 2. An idle live run is stopped with SIGTERM, then resumed once its
//!    process exits. The conversation is already on disk at idle.
//! 3. A busy live run (or one whose turn state is unknown) waits in the
//!    gather queue and moves when its turn ends.
//!
//! The window opens before any process is stopped, so a missing Automation
//! permission fails the call without touching a run.

use crate::index::{launch_request, AgentIndex, RunClaim};
use crate::model::{AgentRun, GatherItem, GatherResponse, LiveInfo, LiveStatus};
use crate::procs;
use chrono::Utc;
use gctrl_mac_comm::launch::{LaunchRequest, WindowResponse};
use gctrl_mac_comm::CommError;
use serde::Deserialize;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

trait GatherOps: Send + Sync + 'static {
    fn refresh(
        &self,
        index: &Arc<AgentIndex>,
        age: Duration,
    ) -> impl std::future::Future<Output = Vec<AgentRun>> + Send;
    fn window(
        &self,
        requests: &[LaunchRequest],
    ) -> impl std::future::Future<Output = Result<WindowResponse, CommError>> + Send;
    fn resume(
        &self,
        index: &AgentIndex,
        window: i64,
        run: &AgentRun,
    ) -> impl std::future::Future<Output = Result<(), CommError>> + Send;
    fn stop(&self, live: &LiveInfo) -> impl std::future::Future<Output = bool> + Send;
    fn close(&self, tty: &str) -> impl std::future::Future<Output = Option<String>> + Send;
    fn wait(&self) -> impl std::future::Future<Output = ()> + Send;
}

struct NativeOps;

impl GatherOps for NativeOps {
    async fn refresh(&self, index: &Arc<AgentIndex>, age: Duration) -> Vec<AgentRun> {
        refresh(index, age).await
    }
    async fn window(&self, requests: &[LaunchRequest]) -> Result<WindowResponse, CommError> {
        gctrl_mac_comm::open_window(requests).await
    }
    async fn resume(
        &self,
        index: &AgentIndex,
        window: i64,
        run: &AgentRun,
    ) -> Result<(), CommError> {
        resume_into(index, window, run).await
    }
    async fn stop(&self, live: &LiveInfo) -> bool {
        stop(live).await
    }
    async fn close(&self, tty: &str) -> Option<String> {
        close_if_bare(tty).await
    }
    async fn wait(&self) {
        tokio::time::sleep(QUEUE_POLL).await
    }
}

/// Most runs one gather moves.
pub const MAX_RUNS: usize = 32;
/// How long a stopped run's process has to exit.
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// How often a queued run's turn state is checked, and for how long.
const QUEUE_POLL: Duration = Duration::from_secs(3);
const QUEUE_LIMIT: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, Deserialize)]
pub struct GatherRequest {
    pub ids: Vec<String>,
    /// Close each stopped run's old pane when only a shell is left on it.
    #[serde(default)]
    pub close_old: bool,
}

#[derive(Debug, PartialEq)]
enum Plan {
    Resume,
    Stop(LiveInfo),
    Queue,
    Skip(&'static str),
}

fn plan(run: Option<&AgentRun>, queued: bool) -> Plan {
    let Some(run) = run else {
        return Plan::Skip("unknown_run");
    };
    if queued {
        return Plan::Skip("already_queued");
    }
    if !run.cwd_exists {
        return Plan::Skip("cwd_missing");
    }
    match &run.live {
        None => Plan::Resume,
        Some(l) if l.tty.is_none() => Plan::Skip("no_tty"),
        Some(l) if l.status == LiveStatus::Idle => Plan::Stop(l.clone()),
        Some(_) => Plan::Queue,
    }
}

fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// SIGTERM the run's process and wait for it to exit. The pid must still be
/// on the run's tty, so a pid reused since the last refresh is never hit.
async fn stop(live: &LiveInfo) -> bool {
    let pid = live.pid;
    let tty = live.tty.clone();
    let signalled = tokio::task::spawn_blocking(move || {
        let procs = procs::snapshot();
        let same = procs.get(&pid).is_some_and(|p| p.tty == tty);
        same && Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .is_ok_and(|s| s.success())
    })
    .await
    .unwrap_or(false);
    if !signalled {
        return false;
    }
    let deadline = Instant::now() + EXIT_WAIT;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    !alive(pid)
}

/// Close the pane on `tty` when only shells are left on it.
async fn close_if_bare(tty: &str) -> Option<String> {
    let t = tty.to_string();
    let bare = tokio::task::spawn_blocking(move || {
        let procs = procs::snapshot();
        let on_tty: Vec<_> = procs
            .values()
            .filter(|p| p.tty.as_deref() == Some(t.as_str()))
            .collect();
        on_tty.iter().all(|p| procs::is_shell(p))
    })
    .await
    .unwrap_or(false);
    if !bare {
        return None;
    }
    gctrl_mac_comm::close_tty(tty).await.ok().flatten()
}

async fn refresh(index: &Arc<AgentIndex>, max_age: Duration) -> Vec<AgentRun> {
    let idx = Arc::clone(index);
    tokio::task::spawn_blocking(move || idx.refresh_if_older(max_age, Utc::now()))
        .await
        .unwrap_or_default()
}

/// The run's live info when a fresh refresh still reports it idle, so a
/// prompt sent since planning is never interrupted.
async fn still_idle(index: &Arc<AgentIndex>, id: &str, ops: &impl GatherOps) -> Option<LiveInfo> {
    ops.refresh(index, Duration::ZERO)
        .await
        .into_iter()
        .find(|r| r.id == id)
        .and_then(|r| r.live)
        .filter(|l| l.status == LiveStatus::Idle)
}

/// Type `run`'s resume command into the gather window, falling back to a
/// new window when that one was closed.
async fn resume_into(index: &AgentIndex, window_id: i64, run: &AgentRun) -> Result<(), CommError> {
    let req = launch_request(run.harness, &run.native_id, &run.cwd);
    let reuse = index.take_fresh_window(window_id);
    match gctrl_mac_comm::open_tab_in_window(window_id, &req, reuse).await {
        Ok(_) => Ok(()),
        Err(CommError::Validation { field, pattern }) => {
            Err(CommError::Validation { field, pattern })
        }
        Err(_) => gctrl_mac_comm::open_window(&[req]).await.map(|_| ()),
    }
}

fn item(id: &str, action: &str, detail: Option<String>) -> GatherItem {
    GatherItem {
        id: id.to_string(),
        action: action.to_string(),
        detail,
    }
}

pub async fn gather(
    index: Arc<AgentIndex>,
    req: GatherRequest,
) -> Result<GatherResponse, CommError> {
    gather_with(index, req, Arc::new(NativeOps)).await
}

async fn gather_with<O: GatherOps>(
    index: Arc<AgentIndex>,
    req: GatherRequest,
    ops: Arc<O>,
) -> Result<GatherResponse, CommError> {
    // Terminal operations retain their claims if the HTTP caller disconnects.
    tokio::spawn(gather_claimed(index, req, ops))
        .await
        .map_err(|error| CommError::Io(std::io::Error::other(error)))?
}

async fn gather_claimed<O: GatherOps>(
    index: Arc<AgentIndex>,
    req: GatherRequest,
    ops: Arc<O>,
) -> Result<GatherResponse, CommError> {
    // Liveness must be current: a stale "not live" would launch a duplicate.
    let runs = ops.refresh(&index, Duration::ZERO).await;
    let mut ids: Vec<&String> = Vec::new();
    for id in &req.ids {
        if !ids.contains(&id) && ids.len() < MAX_RUNS {
            ids.push(id);
        }
    }
    let mut plans: Vec<(&str, Option<&AgentRun>, Plan, Option<RunClaim>)> = ids
        .iter()
        .map(|id| {
            let run = runs.iter().find(|r| &r.id == *id);
            let mut planned = plan(run, false);
            let claim = if matches!(planned, Plan::Skip(_)) {
                None
            } else {
                let claim = index.claim_run(id);
                if claim.is_none() {
                    planned = Plan::Skip("operation_in_progress");
                }
                claim
            };
            (id.as_str(), run, planned, claim)
        })
        .collect();

    let mut items = Vec::new();
    let movable = plans.iter().any(|(_, _, p, _)| !matches!(p, Plan::Skip(_)));
    if !movable {
        for (id, _, p, _) in &plans {
            if let Plan::Skip(why) = p {
                items.push(item(id, "skipped", Some((*why).into())));
            }
        }
        return Ok(GatherResponse {
            window_id: None,
            items,
        });
    }

    // The first directly resumable run seeds the window; otherwise it opens
    // with a shell that the first moved run reuses.
    let seed = plans
        .iter()
        .find(|(_, _, p, _)| *p == Plan::Resume)
        .and_then(|(_, r, _, _)| *r);
    let seed_req: Vec<_> = seed
        .map(|r| launch_request(r.harness, &r.native_id, &r.cwd))
        .into_iter()
        .collect();
    if let Some(seed) = seed {
        plans
            .iter()
            .find(|(id, _, _, _)| *id == seed.id)
            .and_then(|(_, _, _, claim)| claim.as_ref())
            .expect("claimed seed")
            .launched();
    }
    let window = ops.window(&seed_req).await?;
    if seed.is_none() {
        index.mark_fresh_window(window.window_id);
    }

    for (id, run, p, claim) in &mut plans {
        match p {
            Plan::Skip(why) => items.push(item(id, "skipped", Some((*why).into()))),
            Plan::Resume => {
                let claim = claim.take().expect("claimed run");
                let run = run.expect("planned run");
                if Some(run.id.as_str()) == seed.map(|s| s.id.as_str()) {
                    claim.launched();
                    items.push(item(id, "resumed", None));
                    continue;
                }
                claim.launched();
                match ops.resume(&index, window.window_id, run).await {
                    Ok(()) => {
                        claim.launched();
                        items.push(item(id, "resumed", None));
                    }
                    Err(e) => items.push(item(id, "skipped", Some(e.to_string()))),
                }
            }
            Plan::Stop(_) => {
                let claim = claim.take().expect("claimed run");
                let run = run.expect("planned run");
                let Some(live) = still_idle(&index, &run.id, ops.as_ref()).await else {
                    // Busy again since planning: wait for this turn instead.
                    claim.queue();
                    tokio::spawn(wait_and_move(
                        Arc::clone(&index),
                        run.id.clone(),
                        window.window_id,
                        req.close_old,
                        Arc::clone(&ops),
                        claim,
                    ));
                    items.push(item(id, "queued", Some("waits for its turn to end".into())));
                    continue;
                };
                let live = &live;
                if !ops.stop(live).await {
                    items.push(item(id, "skipped", Some("did_not_exit".into())));
                    continue;
                }
                claim.launched();
                match ops.resume(&index, window.window_id, run).await {
                    Ok(()) => {
                        claim.launched();
                        let closed = match (req.close_old, &live.tty) {
                            (true, Some(tty)) => ops.close(tty).await,
                            _ => None,
                        };
                        items.push(item(
                            id,
                            "moved",
                            closed.map(|app| format!("closed old {app} pane")),
                        ));
                    }
                    // Stopped but not resumed: the board still offers Resume.
                    Err(e) => items.push(item(id, "stopped", Some(e.to_string()))),
                }
            }
            Plan::Queue => {
                let claim = claim.take().expect("claimed run");
                let run = run.expect("planned run");
                claim.queue();
                tokio::spawn(wait_and_move(
                    Arc::clone(&index),
                    run.id.clone(),
                    window.window_id,
                    req.close_old,
                    Arc::clone(&ops),
                    claim,
                ));
                items.push(item(id, "queued", Some("waits for its turn to end".into())));
            }
        }
    }
    Ok(GatherResponse {
        window_id: Some(window.window_id),
        items,
    })
}

/// Move a queued run once its turn ends. Leaves the queue when moved, when
/// the run disappears, when a caller cancels it, or after [`QUEUE_LIMIT`].
async fn wait_and_move<O: GatherOps>(
    index: Arc<AgentIndex>,
    id: String,
    window_id: i64,
    close_old: bool,
    ops: Arc<O>,
    claim: RunClaim,
) {
    let deadline = Instant::now() + QUEUE_LIMIT;
    loop {
        ops.wait().await;
        if claim.cancelled() {
            return;
        }
        if Instant::now() > deadline {
            tracing::info!(run = %id, "gather wait expired");
            break;
        }
        let runs = ops.refresh(&index, Duration::from_secs(1)).await;
        if claim.cancelled() {
            return;
        }
        let Some(run) = runs.into_iter().find(|r| r.id == id) else {
            break;
        };
        let old_tty = match &run.live {
            None => None,
            Some(l) if l.status == LiveStatus::Idle => {
                let Some(l) = still_idle(&index, &id, ops.as_ref()).await else {
                    continue;
                };
                if claim.cancelled() {
                    return;
                }
                if !ops.stop(&l).await {
                    continue;
                }
                l.tty.clone()
            }
            Some(_) => continue,
        };
        claim.launched();
        if let Err(e) = ops.resume(&index, window_id, &run).await {
            tracing::warn!(run = %id, error = %e, "gather resume failed");
        } else {
            claim.launched();
            if let (true, Some(tty)) = (close_old, old_tty) {
                ops.close(&tty).await;
            }
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Harness, RunState};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::sync::Notify;

    struct FakeOps {
        runs: Mutex<Vec<AgentRun>>,
        windows: AtomicUsize,
        resumes: Mutex<Vec<String>>,
        entered: Notify,
        release: Notify,
        tick: Notify,
        fail_window: AtomicBool,
    }

    impl GatherOps for FakeOps {
        async fn refresh(&self, _: &Arc<AgentIndex>, _: Duration) -> Vec<AgentRun> {
            self.runs.lock().unwrap().clone()
        }
        async fn window(&self, requests: &[LaunchRequest]) -> Result<WindowResponse, CommError> {
            let number = self.windows.fetch_add(1, Ordering::SeqCst);
            if number == 0 {
                self.entered.notify_one();
                self.release.notified().await;
            }
            if self.fail_window.load(Ordering::SeqCst) {
                return Err(CommError::NotSupported);
            }
            self.resumes
                .lock()
                .unwrap()
                .extend(requests.iter().map(|r| r.argv.last().unwrap().clone()));
            Ok(WindowResponse {
                window_id: number as i64 + 1,
                commands: Vec::new(),
            })
        }
        async fn resume(&self, _: &AgentIndex, _: i64, run: &AgentRun) -> Result<(), CommError> {
            self.resumes.lock().unwrap().push(run.native_id.clone());
            Ok(())
        }
        async fn stop(&self, _: &LiveInfo) -> bool {
            true
        }
        async fn close(&self, _: &str) -> Option<String> {
            None
        }
        async fn wait(&self) {
            self.tick.notified().await
        }
    }

    fn fake_ops(runs: Vec<AgentRun>) -> Arc<FakeOps> {
        Arc::new(FakeOps {
            runs: Mutex::new(runs),
            windows: AtomicUsize::new(0),
            resumes: Mutex::new(Vec::new()),
            entered: Notify::new(),
            release: Notify::new(),
            tick: Notify::new(),
            fail_window: AtomicBool::new(false),
        })
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn overlapping_gathers(live: Option<LiveInfo>) {
        let index = Arc::new(AgentIndex::with_adapters(Vec::new(), "/nonexistent".into()));
        let queued = live.as_ref().is_some_and(|l| l.status != LiveStatus::Idle);
        let ops = fake_ops(vec![run(live, true)]);
        let req = || GatherRequest {
            ids: vec!["claude:x".into()],
            close_old: false,
        };
        let first = tokio::spawn(gather_with(Arc::clone(&index), req(), Arc::clone(&ops)));
        ops.entered.notified().await;
        let second = tokio::time::timeout(
            Duration::from_secs(1),
            gather_with(Arc::clone(&index), req(), Arc::clone(&ops)),
        )
        .await
        .unwrap()
        .unwrap();
        ops.release.notify_one();
        first.await.unwrap().unwrap();
        assert_eq!(ops.windows.load(Ordering::SeqCst), 1);
        assert!(second.window_id.is_none());
        assert_eq!(second.items[0].action, "skipped");
        if queued {
            assert_eq!(index.gather_queue(), ["claude:x"]);
            ops.runs.lock().unwrap()[0].live = None;
            ops.tick.notify_one();
            wait_until(|| index.gather_queue().is_empty()).await;
        }
        assert_eq!(*ops.resumes.lock().unwrap(), ["x"]);
        let repeated = gather_with(Arc::clone(&index), req(), Arc::clone(&ops))
            .await
            .unwrap();
        assert!(repeated.window_id.is_none());
        assert_eq!(ops.windows.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn overlapping_gathers_resume_once() {
        overlapping_gathers(None).await
    }

    #[tokio::test]
    async fn overlapping_gathers_stop_and_resume_once() {
        overlapping_gathers(live(LiveStatus::Idle, Some("/dev/ttys001"))).await
    }

    #[tokio::test]
    async fn overlapping_gathers_queue_one_worker() {
        overlapping_gathers(live(LiveStatus::Busy, Some("/dev/ttys001"))).await
    }

    #[tokio::test]
    async fn disconnected_caller_keeps_in_flight_gather_claimed() {
        let index = Arc::new(AgentIndex::with_adapters(Vec::new(), "/nonexistent".into()));
        let ops = fake_ops(vec![run(None, true)]);
        let req = || GatherRequest {
            ids: vec!["claude:x".into()],
            close_old: false,
        };
        let caller = tokio::spawn(gather_with(Arc::clone(&index), req(), Arc::clone(&ops)));
        ops.entered.notified().await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        let second = gather_with(Arc::clone(&index), req(), Arc::clone(&ops))
            .await
            .unwrap();
        assert!(second.window_id.is_none());
        assert_eq!(ops.windows.load(Ordering::SeqCst), 1);
        ops.release.notify_one();
        wait_until(|| !ops.resumes.lock().unwrap().is_empty()).await;
        assert!(index.claim_run("claude:x").is_none());
    }

    #[tokio::test]
    async fn failed_window_releases_all_gather_claims() {
        let index = Arc::new(AgentIndex::with_adapters(Vec::new(), "/nonexistent".into()));
        let ops = fake_ops(vec![run(
            live(LiveStatus::Busy, Some("/dev/ttys001")),
            true,
        )]);
        ops.fail_window.store(true, Ordering::SeqCst);
        ops.release.notify_one();
        let result = gather_with(
            Arc::clone(&index),
            GatherRequest {
                ids: vec!["claude:x".into()],
                close_old: false,
            },
            ops,
        )
        .await;
        assert!(matches!(result, Err(CommError::NotSupported)));
        assert!(index.gather_queue().is_empty());
        assert!(index.claim_run("claude:x").is_some());
    }

    #[tokio::test]
    async fn cancelling_queue_prevents_resume_and_releases_claim_after_worker_exits() {
        let index = Arc::new(AgentIndex::with_adapters(Vec::new(), "/nonexistent".into()));
        let ops = fake_ops(vec![run(
            live(LiveStatus::Busy, Some("/dev/ttys001")),
            true,
        )]);
        ops.release.notify_one();
        gather_with(
            Arc::clone(&index),
            GatherRequest {
                ids: vec!["claude:x".into()],
                close_old: false,
            },
            Arc::clone(&ops),
        )
        .await
        .unwrap();
        index.dequeue_gather("claude:x");
        assert!(index.claim_run("claude:x").is_none());
        ops.runs.lock().unwrap()[0].live = None;
        ops.tick.notify_one();
        wait_until(|| index.claim_run("claude:x").is_some()).await;
        assert!(ops.resumes.lock().unwrap().is_empty());
    }

    fn run(live: Option<LiveInfo>, cwd_exists: bool) -> AgentRun {
        AgentRun {
            id: "claude:x".into(),
            harness: Harness::ClaudeCode,
            native_id: "x".into(),
            title: "t".into(),
            name: None,
            project_key: "p".into(),
            cwd: "/w".into(),
            cwd_exists,
            worktree: None,
            git_branch: None,
            goal: None,
            progress: None,
            map: None,
            last_prompt: None,
            pr: None,
            cost_usd: None,
            tokens: None,
            model: None,
            started_at: String::new(),
            updated_at: String::new(),
            headless: false,
            archived: false,
            stale: false,
            live,
            state: RunState::Idle,
            resume_command: None,
        }
    }

    fn live(status: LiveStatus, tty: Option<&str>) -> Option<LiveInfo> {
        Some(LiveInfo {
            pid: 7,
            tty: tty.map(str::to_string),
            status,
        })
    }

    #[test]
    fn plans_by_liveness_and_turn_state() {
        assert_eq!(plan(None, false), Plan::Skip("unknown_run"));
        assert_eq!(
            plan(Some(&run(None, true)), true),
            Plan::Skip("already_queued")
        );
        assert_eq!(
            plan(Some(&run(None, false)), false),
            Plan::Skip("cwd_missing")
        );
        assert_eq!(plan(Some(&run(None, true)), false), Plan::Resume);
        let idle = run(live(LiveStatus::Idle, Some("/dev/ttys001")), true);
        assert!(matches!(plan(Some(&idle), false), Plan::Stop(_)));
        let busy = run(live(LiveStatus::Busy, Some("/dev/ttys001")), true);
        assert_eq!(plan(Some(&busy), false), Plan::Queue);
        let unknown = run(live(LiveStatus::Unknown, Some("/dev/ttys001")), true);
        assert_eq!(plan(Some(&unknown), false), Plan::Queue);
        let headless = run(live(LiveStatus::Idle, None), true);
        assert_eq!(plan(Some(&headless), false), Plan::Skip("no_tty"));
    }

    #[test]
    fn gather_queue_dedupes() {
        let idx = Arc::new(AgentIndex::new(crate::index::Paths::from_home(
            std::path::Path::new("/nonexistent"),
        )));
        let claim = idx.claim_run("claude:x").unwrap();
        claim.queue();
        assert!(idx.claim_run("claude:x").is_none());
        assert_eq!(idx.gather_queue(), vec!["claude:x".to_string()]);
        idx.dequeue_gather("claude:x");
        assert!(idx.gather_queue().is_empty());
    }

    #[tokio::test]
    async fn hermes_compression_keeps_queued_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(tmp.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL,
               ended_at REAL, end_reason TEXT, parent_session_id TEXT, cwd TEXT);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
               content TEXT, tool_calls TEXT, timestamp REAL);
             INSERT INTO sessions VALUES ('root', 'cli', 1, NULL, NULL, NULL, '/tmp');
             INSERT INTO messages VALUES (1, 'root', 'user', 'work', NULL, 2);",
        )
        .unwrap();
        let index = Arc::new(AgentIndex::with_adapters(
            vec![Box::new(crate::hermes::HermesAdapter::new(
                tmp.path().to_path_buf(),
                "/tmp".into(),
            ))],
            tmp.path().to_path_buf(),
        ));
        let mut before = index.refresh(Utc::now());
        let queued_id = before[0].id.clone();
        before[0].live = live(LiveStatus::Busy, Some("/dev/ttys001"));
        let ops = fake_ops(before);
        ops.release.notify_one();
        let gathered = gather_with(
            Arc::clone(&index),
            GatherRequest {
                ids: vec![queued_id.clone()],
                close_old: false,
            },
            Arc::clone(&ops),
        )
        .await
        .unwrap();
        assert_eq!(gathered.items[0].action, "queued");
        db.execute_batch(
            "UPDATE sessions SET ended_at=3, end_reason='compression' WHERE id='root';
             INSERT INTO sessions VALUES ('child', 'cli', 3, NULL, NULL, 'root', '/tmp');
             INSERT INTO messages VALUES (2, 'child', 'assistant', 'done', NULL, 4);",
        )
        .unwrap();
        let after = index.refresh(Utc::now());
        let queued = after
            .iter()
            .find(|run| run.id == queued_id)
            .expect("queued conversation survives compression");
        assert_eq!(queued.native_id, "child");
        assert_eq!(
            launch_request(queued.harness, &queued.native_id, &queued.cwd).argv,
            ["hermes", "--resume", "child"]
        );
        assert_eq!(index.gather_queue(), [queued_id]);
        *ops.runs.lock().unwrap() = after;
        ops.tick.notify_one();
        wait_until(|| index.gather_queue().is_empty()).await;
        assert_eq!(*ops.resumes.lock().unwrap(), ["child"]);
    }
}
