//! In-memory index of agent runs, rebuilt from the harness stores.

use crate::claude::{self, LiveEntry, Transcript};
use crate::codex::{self, RolloutCache, Thread};
use crate::model::{AgentRun, Harness, Hidden, ListResponse, LiveInfo, LiveStatus, RunState};
use crate::procs::{self, Proc};
use crate::project::Resolver;
use crate::text::find_uuid;
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use gctrl_mac_comm::launch::{shell_command, LaunchRequest};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// A run with no live process and no activity for this long is stale.
pub fn stale_after() -> chrono::Duration {
    chrono::Duration::days(7)
}

/// A Codex rollout written this recently means a turn is in progress.
const BUSY_WINDOW: Duration = Duration::from_secs(10);

/// Two launches of the same run inside this window are treated as one click.
const LAUNCH_DEBOUNCE: Duration = Duration::from_secs(5);

/// Claude config dirs are discovered under `home` on every refresh
/// ([`claude::config_dirs`]); Codex lives in `codex_home`.
#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub codex_home: PathBuf,
}

impl Paths {
    pub fn from_home(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            codex_home: home.join(".codex"),
        }
    }

    pub fn detect() -> Self {
        Self::from_home(&dirs::home_dir().unwrap_or_else(|| PathBuf::from("/nonexistent")))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions {
    pub include_headless: bool,
    pub include_stale: bool,
}

struct Inner {
    transcripts: HashMap<PathBuf, Transcript>,
    rollouts: RolloutCache,
    resolver: Resolver,
    runs: Vec<AgentRun>,
    refreshed: Option<Instant>,
}

pub struct AgentIndex {
    paths: Paths,
    inner: Mutex<Inner>,
    launches: Mutex<HashMap<String, Instant>>,
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

fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

fn from_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default()
}

fn from_system(t: SystemTime) -> DateTime<Utc> {
    DateTime::<Utc>::from(t)
}

/// Fixed resume templates (spec § Open and resume).
pub fn launch_request(harness: Harness, native_id: &str, cwd: &str) -> LaunchRequest {
    let argv: Vec<&str> = match harness {
        Harness::ClaudeCode => vec!["claude", "--resume", native_id],
        Harness::Codex => vec!["codex", "resume", "-c", "tui.resume_cwd=current", native_id],
    };
    LaunchRequest {
        cwd: cwd.to_string(),
        argv: argv.into_iter().map(str::to_string).collect(),
    }
}

/// Live Claude sessions by session id. A registry entry counts when its pid
/// exists and either its start time matches or the process is a `claude`
/// CLI; a pid reused after a reboot matches neither.
pub fn claude_live(registry: &[LiveEntry], procs: &HashMap<u32, Proc>) -> HashMap<String, LiveInfo> {
    let mut out: HashMap<String, LiveInfo> = HashMap::new();
    for e in registry {
        let Some(p) = procs.get(&e.pid) else { continue };
        let start_matches = e
            .proc_start
            .as_deref()
            .map(procs::normalize_lstart)
            .is_some_and(|s| s == p.lstart);
        if !start_matches && !procs::is_claude_cli(p) {
            continue;
        }
        let status = match e.status.as_deref() {
            Some("busy") => LiveStatus::Busy,
            Some("idle") => LiveStatus::Idle,
            _ => LiveStatus::Unknown,
        };
        let info = LiveInfo {
            pid: e.pid,
            tty: p.tty.clone(),
            status,
        };
        let key = e.session_id.to_ascii_lowercase();
        match out.get(&key) {
            Some(cur) if cur.status == LiveStatus::Busy => {}
            _ => {
                out.insert(key, info);
            }
        }
    }
    out
}

/// Live Codex threads by thread id. One interactive process per tty (the
/// lowest pid, which is the parent of any helper it spawned). A process
/// resumed by id carries the id in argv; otherwise it maps to the most
/// recently updated unclaimed thread in its cwd.
pub fn codex_live(
    threads: &[Thread],
    procs: &HashMap<u32, Proc>,
    cwds: &HashMap<u32, String>,
) -> HashMap<String, u32> {
    let mut by_tty: HashMap<&str, &Proc> = HashMap::new();
    for p in procs.values().filter(|p| procs::is_codex_cli(p)) {
        let Some(tty) = p.tty.as_deref() else { continue };
        match by_tty.get(tty) {
            Some(cur) if cur.pid < p.pid => {}
            _ => {
                by_tty.insert(tty, p);
            }
        }
    }
    let known: HashSet<&str> = threads.iter().map(|t| t.id.as_str()).collect();
    let mut claimed: HashMap<String, u32> = HashMap::new();
    let mut pending: Vec<&Proc> = Vec::new();
    for p in by_tty.values() {
        match find_uuid(&p.command).filter(|id| known.contains(id.as_str())) {
            Some(id) => {
                claimed.insert(id, p.pid);
            }
            None => pending.push(p),
        }
    }
    for p in pending {
        let Some(cwd) = cwds.get(&p.pid) else { continue };
        let newest = threads
            .iter()
            .filter(|t| &t.cwd == cwd && !claimed.contains_key(&t.id) && !t.headless())
            .max_by_key(|t| t.updated_at_ms);
        if let Some(t) = newest {
            claimed.insert(t.id.clone(), p.pid);
        }
    }
    claimed
}

impl AgentIndex {
    pub fn new(paths: Paths) -> Self {
        let resolver = Resolver::new(paths.home.clone());
        Self {
            paths,
            inner: Mutex::new(Inner {
                transcripts: HashMap::new(),
                rollouts: RolloutCache::default(),
                resolver,
                runs: Vec::new(),
                refreshed: None,
            }),
            launches: Mutex::new(HashMap::new()),
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

    /// Rebuild every run from the harness stores and the process table.
    pub fn refresh(&self, now: DateTime<Utc>) -> Vec<AgentRun> {
        let procs = procs::snapshot();
        let mut guard = self.inner.lock().expect("agent index lock");
        let inner = &mut *guard;

        let config = claude::config_dirs(&self.paths.home);
        claude::scan(
            &claude::unique_subdirs(&config, "projects"),
            &mut inner.transcripts,
        );
        let registry: Vec<LiveEntry> = claude::unique_subdirs(&config, "sessions")
            .iter()
            .flat_map(|d| claude::read_registry(d))
            .collect();
        let live = claude_live(&registry, &procs);

        let mut runs = Vec::new();
        let mut seen_claude: HashSet<String> = HashSet::new();
        for t in inner.transcripts.values() {
            let live_info = live.get(&t.session_id).cloned();
            let cwd = t.cwd.clone().or_else(|| {
                registry
                    .iter()
                    .find(|e| e.session_id.eq_ignore_ascii_case(&t.session_id))
                    .and_then(|e| e.cwd.clone())
            });
            let Some(cwd) = cwd else { continue };
            seen_claude.insert(t.session_id.clone());
            let updated = t
                .updated_at
                .as_deref()
                .and_then(parse_ts)
                .or_else(|| t.mtime.map(from_system))
                .unwrap_or(now);
            let started = t.started_at.as_deref().and_then(parse_ts).unwrap_or(updated);
            runs.push(self.build_run(
                &mut inner.resolver,
                BuildInput {
                    harness: Harness::ClaudeCode,
                    native_id: t.session_id.clone(),
                    title: t.title().unwrap_or_else(|| "(untitled)".into()),
                    name: t.agent_name.clone(),
                    cwd,
                    origin: None,
                    git_branch: t.git_branch.clone(),
                    last_prompt: t.last_prompt.clone(),
                    pr: t.pr.clone(),
                    cost_usd: t.cost_usd,
                    tokens: None,
                    model: None,
                    started,
                    updated,
                    headless: t.headless(),
                    archived: false,
                    live: live_info,
                },
                now,
            ));
        }
        // A live session with no transcript yet (no message sent).
        for e in &registry {
            let id = e.session_id.to_ascii_lowercase();
            let (Some(info), Some(cwd)) = (live.get(&id), e.cwd.clone()) else {
                continue;
            };
            if !seen_claude.insert(id.clone()) {
                continue;
            }
            runs.push(self.build_run(
                &mut inner.resolver,
                BuildInput {
                    harness: Harness::ClaudeCode,
                    native_id: id,
                    title: e.name.clone().unwrap_or_else(|| "(new session)".into()),
                    name: e.name.clone(),
                    cwd,
                    origin: None,
                    git_branch: None,
                    last_prompt: None,
                    pr: None,
                    cost_usd: None,
                    tokens: None,
                    model: None,
                    started: now,
                    updated: now,
                    headless: e.kind.as_deref() == Some("bg"),
                    archived: false,
                    live: Some(info.clone()),
                },
                now,
            ));
        }

        let threads = codex::find_state_db(&self.paths.codex_home)
            .map(|db| {
                codex::read_threads(&db).unwrap_or_else(|e| {
                    tracing::warn!(db = %db.display(), error = %e, "codex threads unreadable");
                    Vec::new()
                })
            })
            .unwrap_or_default();
        let codex_pids: Vec<u32> = procs
            .values()
            .filter(|p| procs::is_codex_cli(p))
            .map(|p| p.pid)
            .collect();
        let cwds = procs::cwds(&codex_pids);
        let codex_live_map = codex_live(&threads, &procs, &cwds);
        for t in &threads {
            let rollout = PathBuf::from(&t.rollout_path);
            let live_info = codex_live_map.get(&t.id).map(|pid| {
                let busy = RolloutCache::mtime(&rollout)
                    .and_then(|m| SystemTime::now().duration_since(m).ok())
                    .is_some_and(|age| age < BUSY_WINDOW);
                LiveInfo {
                    pid: *pid,
                    tty: procs.get(pid).and_then(|p| p.tty.clone()),
                    status: if busy { LiveStatus::Busy } else { LiveStatus::Idle },
                }
            });
            let updated = from_ms(t.updated_at_ms);
            // Only read rollouts for runs the default view shows.
            let last_prompt = if !t.headless()
                && (live_info.is_some() || !is_stale(false, updated, now))
            {
                inner.rollouts.last_prompt(&rollout)
            } else {
                None
            };
            runs.push(self.build_run(
                &mut inner.resolver,
                BuildInput {
                    harness: Harness::Codex,
                    native_id: t.id.clone(),
                    title: t.display_title(),
                    name: t.name.clone().filter(|n| !n.is_empty()),
                    cwd: t.cwd.clone(),
                    origin: t.git_origin_url.clone(),
                    git_branch: t.git_branch.clone(),
                    last_prompt,
                    pr: None,
                    cost_usd: None,
                    tokens: Some(t.tokens_used),
                    model: t.model.clone(),
                    started: from_ms(t.created_at_ms),
                    updated,
                    headless: t.headless(),
                    archived: t.archived,
                    live: live_info,
                },
                now,
            ));
        }

        runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        inner.runs = runs.clone();
        inner.refreshed = Some(Instant::now());
        runs
    }

    fn build_run(&self, resolver: &mut Resolver, i: BuildInput, now: DateTime<Utc>) -> AgentRun {
        let resolved = resolver.resolve(&i.cwd, i.origin.as_deref());
        let cwd_exists = Path::new(&i.cwd).is_dir();
        let resume_command = cwd_exists
            .then(|| shell_command(&launch_request(i.harness, &i.native_id, &i.cwd)).ok())
            .flatten();
        let state = derive_state(i.archived, i.live.as_ref());
        AgentRun {
            id: format!("{}:{}", i.harness.prefix(), i.native_id),
            harness: i.harness,
            native_id: i.native_id,
            title: i.title,
            name: i.name,
            project_key: resolved.key,
            cwd: i.cwd,
            cwd_exists,
            worktree: resolved.worktree,
            git_branch: i.git_branch,
            last_prompt: i.last_prompt,
            pr: i.pr,
            cost_usd: i.cost_usd,
            tokens: i.tokens,
            model: i.model,
            started_at: rfc3339(i.started),
            updated_at: rfc3339(i.updated),
            headless: i.headless,
            archived: i.archived,
            stale: is_stale(i.live.is_some(), i.updated, now),
            live: i.live,
            state,
            resume_command,
        }
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
}

struct BuildInput {
    harness: Harness,
    native_id: String,
    title: String,
    name: Option<String>,
    cwd: String,
    origin: Option<String>,
    git_branch: Option<String>,
    last_prompt: Option<String>,
    pr: Option<crate::model::PrLink>,
    cost_usd: Option<f64>,
    tokens: Option<i64>,
    model: Option<String>,
    started: DateTime<Utc>,
    updated: DateTime<Utc>,
    headless: bool,
    archived: bool,
    live: Option<LiveInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    const CLAUDE_SID: &str = "26e3373e-8358-416b-83f3-355a59325193";
    const OLD_SID: &str = "aaaaaaaa-8358-416b-83f3-355a59325193";
    const SDK_SID: &str = "bbbbbbbb-8358-416b-83f3-355a59325193";
    const LIVE_ONLY_SID: &str = "cccccccc-8358-416b-83f3-355a59325193";
    const CODEX_ID: &str = "01a04c15-4628-7913-bd1d-21ed78284c55";

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

    fn thread(id: &str, cwd: &str, updated: i64, source: &str) -> Thread {
        Thread {
            id: id.into(),
            rollout_path: String::new(),
            cwd: cwd.into(),
            title: "t".into(),
            name: None,
            first_user_message: None,
            git_branch: None,
            git_origin_url: None,
            tokens_used: 0,
            model: None,
            archived: false,
            source: source.into(),
            created_at_ms: 0,
            updated_at_ms: updated,
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
        let live = codex_live(&threads, &procs, &cwds);
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
        assert_eq!(
            live.resume_command.as_deref(),
            Some(format!("cd '{repo_s}' && claude --resume {CLAUDE_SID}").as_str())
        );

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
