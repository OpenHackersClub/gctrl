//! In-memory index of agent runs, rebuilt from the harness adapters.

use crate::adapter::{Adapter, RunRecord, ScanCtx};
use crate::claude::ClaudeAdapter;
use crate::codex::CodexAdapter;
use crate::hermes::HermesAdapter;
use crate::model::{AgentRun, Harness, Hidden, ListResponse, LiveInfo, LiveStatus, RunState};
use crate::pi::PiAdapter;
use crate::procs;
use crate::project::Resolver;
use chrono::{DateTime, SecondsFormat, Utc};
use gctrl_mac_comm::launch::{shell_command, LaunchRequest};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A run with no live process and no activity for this long is stale.
pub fn stale_after() -> chrono::Duration {
    chrono::Duration::days(7)
}

/// Two launches of the same run inside this window are treated as one click.
const LAUNCH_DEBOUNCE: Duration = Duration::from_secs(5);

/// Where each harness keeps its store. Claude config dirs are discovered
/// under `home` on every refresh ([`crate::claude::config_dirs`]).
#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub hermes_home: PathBuf,
    pub pi_sessions: PathBuf,
}

impl Paths {
    pub fn from_home(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            codex_home: home.join(".codex"),
            hermes_home: home.join(".hermes"),
            pi_sessions: home.join(".pi").join("agent").join("sessions"),
        }
    }

    /// The current user's stores, honoring each harness's home override.
    pub fn detect() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/nonexistent"));
        let mut p = Self::from_home(&home);
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        if let Some(v) = env("CODEX_HOME") {
            p.codex_home = v;
        }
        if let Some(v) = env("HERMES_HOME") {
            p.hermes_home = v;
        }
        if let Some(v) = env("PI_CODING_AGENT_DIR") {
            p.pi_sessions = v.join("sessions");
        }
        if let Some(v) = env("PI_CODING_AGENT_SESSION_DIR") {
            p.pi_sessions = v;
        }
        p
    }

    /// One adapter per supported harness.
    pub fn adapters(&self) -> Vec<Box<dyn Adapter>> {
        let home = self.home.to_string_lossy().into_owned();
        vec![
            Box::new(ClaudeAdapter::new(self.home.clone())),
            Box::new(CodexAdapter::new(self.codex_home.clone())),
            Box::new(HermesAdapter::new(self.hermes_home.clone(), home)),
            Box::new(PiAdapter::new(self.pi_sessions.clone())),
        ]
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions {
    pub include_headless: bool,
    pub include_stale: bool,
}

struct Inner {
    adapters: Vec<Box<dyn Adapter>>,
    resolver: Resolver,
    runs: Vec<AgentRun>,
    refreshed: Option<Instant>,
}

pub struct AgentIndex {
    inner: Mutex<Inner>,
    launches: Mutex<HashMap<String, Instant>>,
    gather_queue: Mutex<Vec<String>>,
    /// Gather windows whose initial shell no run has used yet.
    fresh_windows: Mutex<std::collections::HashSet<i64>>,
}

pub fn derive_state(archived: bool, live: Option<&LiveInfo>) -> RunState {
    if archived {
        return RunState::Done;
    }
    match live {
        Some(l) if l.status == LiveStatus::Busy => RunState::Running,
        Some(_) => RunState::Idle,
        None => RunState::Resumable,
    }
}

pub fn is_stale(live: bool, updated: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    !live && now - updated >= stale_after()
}

fn rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Fixed resume templates (spec § Open and resume).
pub fn launch_request(harness: Harness, native_id: &str, cwd: &str) -> LaunchRequest {
    LaunchRequest {
        cwd: cwd.to_string(),
        argv: harness.resume_argv(native_id),
    }
}

impl AgentIndex {
    pub fn new(paths: Paths) -> Self {
        Self::with_adapters(paths.adapters(), paths.home)
    }

    pub fn with_adapters(adapters: Vec<Box<dyn Adapter>>, home: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner {
                adapters,
                resolver: Resolver::new(home),
                runs: Vec::new(),
                refreshed: None,
            }),
            launches: Mutex::new(HashMap::new()),
            gather_queue: Mutex::new(Vec::new()),
            fresh_windows: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Return cached runs when refreshed within `max_age`, else refresh.
    pub fn refresh_if_older(&self, max_age: Duration, now: DateTime<Utc>) -> Vec<AgentRun> {
        {
            let inner = self.inner.lock().expect("agent index lock");
            if inner.refreshed.is_some_and(|t| t.elapsed() < max_age) {
                return inner.runs.clone();
            }
        }
        self.refresh(now)
    }

    /// Rebuild every run from the adapters and the process table.
    pub fn refresh(&self, now: DateTime<Utc>) -> Vec<AgentRun> {
        let procs = procs::snapshot();
        let ctx = ScanCtx { procs: &procs, now };
        let mut guard = self.inner.lock().expect("agent index lock");
        let inner = &mut *guard;
        let records: Vec<RunRecord> = inner
            .adapters
            .iter_mut()
            .flat_map(|a| a.scan(&ctx))
            .collect();
        let mut runs: Vec<AgentRun> = records
            .into_iter()
            .map(|r| build_run(&mut inner.resolver, r, now))
            .collect();
        runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        inner.runs = runs.clone();
        inner.refreshed = Some(Instant::now());
        runs
    }

    /// Apply the default filters and count what they hide.
    pub fn list(runs: &[AgentRun], opts: ListOptions, now: DateTime<Utc>) -> ListResponse {
        let mut hidden = Hidden::default();
        let mut out = Vec::new();
        for r in runs {
            if r.headless && !opts.include_headless {
                hidden.headless += 1;
            } else if r.stale && !opts.include_stale {
                hidden.stale += 1;
            } else {
                out.push(r.clone());
            }
        }
        ListResponse {
            generated_at: rfc3339(now),
            runs: out,
            hidden,
            gather_queue: Vec::new(),
        }
    }

    /// Record a launch of `id`. False when the same run launched within the
    /// debounce window, so a double click opens one tab.
    pub fn note_launch(&self, id: &str) -> bool {
        let mut l = self.launches.lock().expect("launch lock");
        l.retain(|_, t| t.elapsed() < LAUNCH_DEBOUNCE);
        if l.contains_key(id) {
            return false;
        }
        l.insert(id.to_string(), Instant::now());
        true
    }

    /// Runs a gather is waiting on.
    pub fn gather_queue(&self) -> Vec<String> {
        self.gather_queue.lock().expect("gather lock").clone()
    }

    /// Add `id` to the gather queue; false when it is already queued.
    pub fn enqueue_gather(&self, id: &str) -> bool {
        let mut q = self.gather_queue.lock().expect("gather lock");
        if q.iter().any(|x| x == id) {
            return false;
        }
        q.push(id.to_string());
        true
    }

    pub fn dequeue_gather(&self, id: &str) {
        self.gather_queue.lock().expect("gather lock").retain(|x| x != id);
    }

    /// Record that `window_id` opened with an unused shell.
    pub fn mark_fresh_window(&self, window_id: i64) {
        self.fresh_windows.lock().expect("window lock").insert(window_id);
    }

    /// True once for a window that still has its unused initial shell.
    pub fn take_fresh_window(&self, window_id: i64) -> bool {
        self.fresh_windows.lock().expect("window lock").remove(&window_id)
    }
}

fn build_run(resolver: &mut Resolver, r: RunRecord, now: DateTime<Utc>) -> AgentRun {
    let resolved = resolver.resolve(&r.cwd, r.origin.as_deref());
    let cwd_exists = Path::new(&r.cwd).is_dir();
    let resume_command = cwd_exists
        .then(|| shell_command(&launch_request(r.harness, &r.native_id, &r.cwd)).ok())
        .flatten();
    let state = derive_state(r.archived, r.live.as_ref());
    AgentRun {
        id: format!("{}:{}", r.harness.prefix(), r.native_id),
        harness: r.harness,
        native_id: r.native_id,
        title: r.title,
        name: r.name,
        project_key: resolved.key,
        cwd: r.cwd,
        cwd_exists,
        worktree: resolved.worktree,
        git_branch: r.git_branch,
        last_prompt: r.last_prompt,
        pr: r.pr,
        cost_usd: r.cost_usd,
        tokens: r.tokens,
        model: r.model,
        started_at: rfc3339(r.started),
        updated_at: rfc3339(r.updated),
        headless: r.headless,
        archived: r.archived,
        stale: is_stale(r.live.is_some(), r.updated, now),
        live: r.live,
        state,
        resume_command,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{match_processes, Candidate};
    use crate::claude::{claude_live, LiveEntry};
    use crate::procs::Proc;
    use chrono::TimeZone;
    use rusqlite::Connection;

    const CLAUDE_SID: &str = "26e3373e-8358-416b-83f3-355a59325193";
    const OLD_SID: &str = "aaaaaaaa-8358-416b-83f3-355a59325193";
    const SDK_SID: &str = "bbbbbbbb-8358-416b-83f3-355a59325193";
    const LIVE_ONLY_SID: &str = "cccccccc-8358-416b-83f3-355a59325193";
    const CODEX_ID: &str = "01a04c15-4628-7913-bd1d-21ed78284c55";
    const PI_ID: &str = "019a0b7c-1d2e-7f30-8a41-5b6c7d8e9f01";

    fn proc(pid: u32, lstart: &str, tty: Option<&str>, command: &str) -> Proc {
        Proc {
            pid,
            lstart: lstart.into(),
            tty: tty.map(str::to_string),
            command: command.into(),
        }
    }

    #[test]
    fn state_derivation() {
        let busy = LiveInfo { pid: 1, tty: None, status: LiveStatus::Busy };
        let idle = LiveInfo { pid: 1, tty: None, status: LiveStatus::Idle };
        assert_eq!(derive_state(false, Some(&busy)), RunState::Running);
        assert_eq!(derive_state(false, Some(&idle)), RunState::Idle);
        assert_eq!(derive_state(false, None), RunState::Resumable);
        assert_eq!(derive_state(true, Some(&busy)), RunState::Done);
    }

    #[test]
    fn staleness() {
        let now = Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 0).unwrap();
        let eight_days = now - chrono::Duration::days(8);
        let two_days = now - chrono::Duration::days(2);
        assert!(is_stale(false, eight_days, now));
        assert!(!is_stale(true, eight_days, now));
        assert!(!is_stale(false, two_days, now));
    }

    #[test]
    fn claude_liveness_rejects_reused_pid() {
        let registry = vec![
            LiveEntry {
                pid: 10,
                session_id: CLAUDE_SID.to_uppercase(),
                cwd: None,
                status: Some("busy".into()),
                proc_start: Some("Fri Nov 27 10:30:03 2026".into()),
                kind: None,
                name: None,
            },
            LiveEntry {
                pid: 11,
                session_id: OLD_SID.into(),
                cwd: None,
                status: Some("idle".into()),
                proc_start: Some("Mon Nov 16 08:00:00 2026".into()),
                kind: None,
                name: None,
            },
        ];
        let procs: HashMap<u32, Proc> = [
            proc(10, "Fri Nov 27 10:30:03 2026", Some("/dev/ttys003"), "node something"),
            // pid 11 now belongs to an unrelated process started after a reboot.
            proc(11, "Sat Nov 28 09:00:00 2026", None, "/usr/sbin/mDNSResponder"),
        ]
        .into_iter()
        .map(|p| (p.pid, p))
        .collect();
        let live = claude_live(&registry, &procs);
        assert_eq!(live.len(), 1);
        let l = &live[CLAUDE_SID];
        assert_eq!(l.status, LiveStatus::Busy);
        assert_eq!(l.tty.as_deref(), Some("/dev/ttys003"));
    }

    #[test]
    fn claude_liveness_requires_known_start_time_even_for_another_claude() {
        let mut entry = LiveEntry {
            pid: 11,
            session_id: OLD_SID.into(),
            cwd: None,
            status: Some("idle".into()),
            proc_start: Some("Mon Nov 16 08:00:00 2026".into()),
            kind: None,
            name: None,
        };
        let process = proc(11, "Sat Nov 28 09:00:00 2026", Some("/dev/ttys003"), "claude --resume another");
        let procs = [(11, process)].into_iter().collect();
        assert!(claude_live(&[entry.clone()], &procs).is_empty());

        entry.proc_start = None;
        assert_eq!(claude_live(&[entry], &procs).len(), 1);
    }

    fn thread<'a>(id: &'a str, cwd: &'a str, updated: i64, source: &str) -> Candidate<'a> {
        Candidate {
            alias: id,
            run: id,
            cwd,
            updated_ms: updated,
            interactive: source != "exec",
        }
    }

    #[test]
    fn codex_liveness_by_argv_then_cwd() {
        let threads = vec![
            thread(CODEX_ID, "/w/api", 100, "cli"),
            thread("22222222-2222-2222-2222-222222222222", "/w/web", 50, "cli"),
            thread("33333333-3333-3333-3333-333333333333", "/w/web", 90, "cli"),
            thread("44444444-4444-4444-4444-444444444444", "/w/web", 99, "exec"),
        ];
        let procs: HashMap<u32, Proc> = [
            proc(100, "x x x x x", Some("/dev/ttys001"), &format!("/b/codex --no-daemon resume {CODEX_ID}")),
            proc(200, "x x x x x", Some("/dev/ttys002"), "/b/codex"),
            // Helper spawned by pid 200 on the same tty.
            proc(201, "x x x x x", Some("/dev/ttys002"), "/b/codex app-server"),
            proc(300, "x x x x x", None, "/Applications/Codex.app/Contents/MacOS/codex"),
        ]
        .into_iter()
        .map(|p| (p.pid, p))
        .collect();
        let cwds: HashMap<u32, String> =
            [(200, "/w/web".to_string()), (201, "/w/web".to_string())].into_iter().collect();
        let live = match_processes(&threads, &procs, procs::is_codex_cli, |_| cwds);
        assert_eq!(live.get(CODEX_ID), Some(&100));
        assert_eq!(live.get("33333333-3333-3333-3333-333333333333"), Some(&200));
        assert_eq!(live.len(), 2);
    }

    #[test]
    fn launch_templates() {
        let c = launch_request(Harness::ClaudeCode, CLAUDE_SID, "/w/api");
        assert_eq!(c.argv, vec!["claude", "--resume", CLAUDE_SID]);
        let x = launch_request(Harness::Codex, CODEX_ID, "/w/api");
        assert_eq!(
            x.argv,
            vec!["codex", "resume", "-c", "tui.resume_cwd=current", CODEX_ID]
        );
        let h = launch_request(Harness::Hermes, "20260420_134853_5501ee", "/w/api");
        assert_eq!(h.argv, vec!["hermes", "--resume", "20260420_134853_5501ee"]);
        let p = launch_request(Harness::Pi, CODEX_ID, "/w/api");
        assert_eq!(p.argv, vec!["pi", "--session", CODEX_ID]);
        for harness in Harness::ALL {
            assert!(shell_command(&launch_request(harness, CLAUDE_SID, "/w/api")).is_ok());
        }
    }

    fn transcript(cwd: &str, ts: &str, entry: &str) -> String {
        format!(
            "{}\n{}\n",
            format_args!(
                r#"{{"type":"user","cwd":"{cwd}","gitBranch":"main","entrypoint":"{entry}","timestamp":"{ts}","message":{{"content":"ship it"}}}}"#
            ),
            r#"{"type":"custom-title","customTitle":"ship-it"}"#
        )
    }

    #[test]
    fn refresh_builds_runs_from_a_fake_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let repo = home.join("src").join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_str().unwrap();

        let proj = home.join(".claude/projects/-src-api");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join(format!("{CLAUDE_SID}.jsonl")),
            transcript(repo_s, "2026-11-27T10:00:00.000Z", "cli"),
        )
        .unwrap();
        std::fs::write(
            proj.join(format!("{OLD_SID}.jsonl")),
            transcript(repo_s, "2026-10-01T10:00:00.000Z", "cli"),
        )
        .unwrap();
        std::fs::write(
            proj.join(format!("{SDK_SID}.jsonl")),
            transcript(repo_s, "2026-11-27T10:00:00.000Z", "sdk-cli"),
        )
        .unwrap();

        // The test process itself stands in for a live Claude session.
        let me = std::process::id();
        let procs = procs::snapshot();
        let my_start = procs.get(&me).map(|p| p.lstart.clone()).unwrap_or_default();
        let sessions = home.join(".claude/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        for (sid, status) in [(CLAUDE_SID, "busy"), (LIVE_ONLY_SID, "idle")] {
            let pid_file = sessions.join(format!("{}-{me}.json", &sid[..8]));
            std::fs::write(
                pid_file,
                serde_json::json!({
                    "pid": me, "sessionId": sid, "cwd": repo_s,
                    "status": status, "procStart": my_start, "name": "s-new"
                })
                .to_string(),
            )
            .unwrap();
        }

        let codex_home = home.join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let c = Connection::open(codex_home.join("state_5.sqlite")).unwrap();
        c.execute_batch(&format!(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
               cwd TEXT NOT NULL, title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
               archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT, git_origin_url TEXT,
               name TEXT, thread_source TEXT);
             INSERT INTO threads VALUES ('{CODEX_ID}', '/nonexistent/r.jsonl', 1795000000,
               1795800000, 'cli', '/gone/billing', 'Fix billing', 1200, 1, 'main',
               'https://github.com/acme/billing.git', 'Fix billing', 'user');"
        ))
        .unwrap();
        drop(c);

        let hermes_home = home.join(".hermes");
        std::fs::create_dir_all(&hermes_home).unwrap();
        let h = Connection::open(hermes_home.join("state.db")).unwrap();
        h.execute_batch(&format!(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL,
               ended_at REAL, end_reason TEXT, parent_session_id TEXT, title TEXT, cwd TEXT);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
               tool_calls TEXT, timestamp REAL);
             INSERT INTO sessions VALUES ('20261127_100000_abcdef', 'tui', 1795780800, NULL, NULL, NULL,
               NULL, '{repo_s}');
             INSERT INTO messages VALUES (1, '20261127_100000_abcdef', 'user', 'triage the inbox', NULL,
               1795780801);"
        ))
        .unwrap();
        drop(h);

        let pi_dir = home.join(".pi/agent/sessions/--src-api--");
        std::fs::create_dir_all(&pi_dir).unwrap();
        std::fs::write(
            pi_dir.join(format!("2026-11-27T10-00-00-000Z_{PI_ID}.jsonl")),
            format!(
                "{}\n{}\n",
                format_args!(r#"{{"type":"session","version":3,"id":"{PI_ID}","timestamp":"2026-11-27T10:00:00.000Z","cwd":"{repo_s}"}}"#),
                r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-27T10:00:01.000Z","message":{"role":"user","content":"tidy the parser"}}"#
            ),
        )
        .unwrap();

        let now = Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 0).unwrap();
        let idx = AgentIndex::new(Paths::from_home(home));
        let runs = idx.refresh(now);
        let by_id: HashMap<&str, &AgentRun> = runs.iter().map(|r| (r.id.as_str(), r)).collect();

        let live = by_id[format!("claude:{CLAUDE_SID}").as_str()];
        assert_eq!(live.title, "ship-it");
        assert_eq!(live.project_key, "api");
        assert!(live.cwd_exists);
        if !my_start.is_empty() {
            assert_eq!(live.state, RunState::Running);
        }
        let command = live.resume_command.as_deref().unwrap();
        assert!(command.starts_with(&format!("cd '{repo_s}' && ")));
        assert!(command.ends_with(&format!(" && claude --resume {CLAUDE_SID}")));

        let old = by_id[format!("claude:{OLD_SID}").as_str()];
        assert!(old.stale);
        assert_eq!(old.state, RunState::Resumable);

        assert!(by_id[format!("claude:{SDK_SID}").as_str()].headless);

        if !my_start.is_empty() {
            let new = by_id[format!("claude:{LIVE_ONLY_SID}").as_str()];
            assert_eq!(new.title, "s-new");
            assert_eq!(new.state, RunState::Idle);
        }

        let codex = by_id[format!("codex:{CODEX_ID}").as_str()];
        assert_eq!(codex.project_key, "billing");
        assert_eq!(codex.state, RunState::Done);
        assert!(!codex.cwd_exists);
        assert_eq!(codex.resume_command, None);
        assert_eq!(codex.tokens, Some(1200));

        let hermes = by_id["hermes:20261127_100000_abcdef"];
        assert_eq!(hermes.title, "triage the inbox");
        assert_eq!(hermes.project_key, "api");
        let command = hermes.resume_command.as_deref().unwrap();
        assert!(command.starts_with(&format!("cd '{repo_s}' && ")));
        assert!(command.ends_with(" && hermes --resume 20261127_100000_abcdef"));

        let pi = by_id[format!("pi:{PI_ID}").as_str()];
        assert_eq!(pi.title, "tidy the parser");
        assert_eq!(pi.state, RunState::Resumable);

        let default_view = AgentIndex::list(&runs, ListOptions::default(), now);
        assert_eq!(default_view.hidden, Hidden { headless: 1, stale: 1 });
        assert!(default_view.runs.iter().all(|r| !r.headless && !r.stale));
        let all = AgentIndex::list(
            &runs,
            ListOptions { include_headless: true, include_stale: true },
            now,
        );
        assert_eq!(all.runs.len(), runs.len());
    }

    #[test]
    fn launch_debounce() {
        let idx = AgentIndex::new(Paths::from_home(Path::new("/nonexistent")));
        assert!(idx.note_launch("claude:x"));
        assert!(!idx.note_launch("claude:x"));
        assert!(idx.note_launch("codex:y"));
    }
}
