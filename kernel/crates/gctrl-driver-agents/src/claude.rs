//! Claude Code reader: transcripts under `~/.claude/projects/<slug>/<uuid>.jsonl`
//! and the live registry `~/.claude/sessions/<pid>.json`.
//!
//! Transcripts are parsed incrementally from a stored byte offset. A file read
//! for the first time is parsed whole when small; otherwise only its head
//! (start time, cwd, first prompt) and tail (titles, last prompt, PR link,
//! cost) are parsed, because Claude Code re-appends those metadata records
//! near the end of the file. The `*.key` files next to the registry hold
//! socket credentials and are never opened.

use crate::adapter::{from_system, parse_ts, Adapter, RunRecord, ScanCtx};
use crate::jsonl::{message_text, Cursor};
use crate::model::{Harness, LiveInfo, LiveStatus, PrLink};
use crate::procs::{self, Proc};
use crate::text::{clip, is_human_prompt, is_uuid};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub entrypoint: Option<String>,
    pub custom_title: Option<String>,
    pub agent_name: Option<String>,
    pub summary: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub pr: Option<PrLink>,
    pub cost_usd: Option<f64>,
    pub mtime: Option<SystemTime>,
    cursor: Cursor,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<Value>,
    cwd: Option<Value>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<Value>,
    timestamp: Option<Value>,
    entrypoint: Option<Value>,
    #[serde(rename = "customTitle")]
    custom_title: Option<Value>,
    #[serde(rename = "agentName")]
    agent_name: Option<Value>,
    summary: Option<Value>,
    #[serde(rename = "lastPrompt")]
    last_prompt: Option<Value>,
    #[serde(rename = "prNumber")]
    pr_number: Option<Value>,
    #[serde(rename = "prUrl")]
    pr_url: Option<Value>,
    #[serde(rename = "prRepository")]
    pr_repository: Option<Value>,
    #[serde(rename = "totalCostUSD")]
    total_cost_usd: Option<Value>,
    #[serde(rename = "isMeta")]
    is_meta: Option<Value>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<Value>,
}

#[derive(Deserialize)]
struct UserLine {
    message: UserMessage,
}

#[derive(Deserialize)]
struct UserMessage {
    content: Value,
}

fn s(v: &Option<Value>) -> Option<&str> {
    v.as_ref().and_then(Value::as_str).filter(|x| !x.is_empty())
}

fn truthy(v: &Option<Value>) -> bool {
    v.as_ref().and_then(Value::as_bool).unwrap_or(false)
}

impl Transcript {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            ..Self::default()
        }
    }

    /// Fold one JSONL record into the summary.
    fn ingest_line(&mut self, raw: &[u8]) {
        let Ok(line) = serde_json::from_slice::<Line>(raw) else {
            return;
        };
        let kind = s(&line.kind).unwrap_or("");

        if let Some(ts) = s(&line.timestamp) {
            if self.started_at.as_deref().is_none_or(|cur| ts < cur) {
                self.started_at = Some(ts.to_string());
            }
            if self.updated_at.as_deref().is_none_or(|cur| ts > cur) {
                self.updated_at = Some(ts.to_string());
            }
        }
        if let Some(v) = s(&line.cwd) {
            self.cwd = Some(v.to_string());
        }
        if let Some(v) = s(&line.git_branch) {
            self.git_branch = Some(v.to_string());
        }
        if let Some(v) = s(&line.entrypoint) {
            self.entrypoint = Some(v.to_string());
        }

        match kind {
            "custom-title" => {
                if let Some(v) = s(&line.custom_title) {
                    self.custom_title = Some(v.to_string());
                }
            }
            "agent-name" => {
                if let Some(v) = s(&line.agent_name) {
                    self.agent_name = Some(v.to_string());
                }
            }
            "summary" => {
                if let Some(v) = s(&line.summary) {
                    self.summary = Some(v.to_string());
                }
            }
            "last-prompt" => {
                if let Some(v) = s(&line.last_prompt) {
                    if is_human_prompt(v) {
                        self.last_prompt = Some(clip(v, 200));
                    }
                }
            }
            "pr-link" => {
                let number = line.pr_number.as_ref().and_then(Value::as_u64);
                if let (Some(number), Some(url)) = (number, s(&line.pr_url)) {
                    self.pr = Some(PrLink {
                        number,
                        url: url.to_string(),
                        repository: s(&line.pr_repository).map(str::to_string),
                    });
                }
            }
            "cost-state" => {
                if let Some(c) = line.total_cost_usd.as_ref().and_then(Value::as_f64) {
                    self.cost_usd = Some(c);
                }
            }
            "user" if self.first_prompt.is_none()
                && !truthy(&line.is_meta)
                && !truthy(&line.is_sidechain) =>
            {
                if let Ok(u) = serde_json::from_slice::<UserLine>(raw) {
                    if let Some(t) = message_text(&u.message.content) {
                        if is_human_prompt(&t) {
                            self.first_prompt = Some(clip(&t, 120));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Bring the summary up to date with the file at `path`.
    pub fn refresh(&mut self, path: &Path) -> std::io::Result<()> {
        let Some(update) = self.cursor.read(path)? else {
            return Ok(());
        };
        if update.reset {
            let cursor = std::mem::take(&mut self.cursor);
            *self = Transcript::new(std::mem::take(&mut self.session_id));
            self.cursor = cursor;
        }
        for line in &update.lines {
            self.ingest_line(line);
        }
        self.mtime = self.cursor.mtime();
        Ok(())
    }

    pub fn title(&self) -> Option<String> {
        self.custom_title
            .clone()
            .or_else(|| self.agent_name.clone())
            .or_else(|| self.summary.as_deref().map(|x| clip(x, 120)))
            .or_else(|| self.first_prompt.clone())
    }

    pub fn headless(&self) -> bool {
        self.entrypoint.as_deref() == Some("sdk-cli")
    }
}

/// Claude Code config dirs under `home`: `~/.claude`, `~/.claude/clients/*`,
/// `~/.claude-*` and `~/.config/claude/*` — the places a per-project
/// `CLAUDE_CONFIG_DIR` points. Each keeps its own live registry; their
/// `projects/` dirs are often symlinks to one shared store.
pub fn config_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![home.join(".claude")];
    let children = |p: PathBuf| -> Vec<PathBuf> {
        std::fs::read_dir(p)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default()
    };
    dirs.extend(children(home.join(".claude").join("clients")));
    dirs.extend(children(home.join(".config").join("claude")));
    if let Ok(rd) = std::fs::read_dir(home) {
        dirs.extend(
            rd.flatten()
                .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(".claude-")))
                .map(|e| e.path())
                .filter(|p| p.is_dir()),
        );
    }
    dirs.retain(|d| d.join("projects").is_dir() || d.join("sessions").is_dir());
    dirs
}

/// Unique real paths of `<dir>/<sub>` across config dirs, so a `projects/`
/// shared through symlinks is scanned once.
pub fn unique_subdirs(dirs: &[PathBuf], sub: &str) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    dirs.iter()
        .filter_map(|d| d.join(sub).canonicalize().ok())
        .filter(|p| p.is_dir() && seen.insert(p.clone()))
        .collect()
}

/// Refresh `cache` against every `<root>/<slug>/<uuid>.jsonl` across
/// `roots`. Entries whose file disappeared are dropped. Subagent transcripts
/// live one level deeper and are not visited.
pub fn scan(roots: &[PathBuf], cache: &mut HashMap<PathBuf, Transcript>) {
    let mut seen = Vec::new();
    for root in roots {
        scan_root(root, cache, &mut seen);
    }
    let keep: std::collections::HashSet<_> = seen.into_iter().collect();
    cache.retain(|p, _| keep.contains(p));
}

fn scan_root(root: &Path, cache: &mut HashMap<PathBuf, Transcript>, seen: &mut Vec<PathBuf>) {
    let Ok(projects) = std::fs::read_dir(root) else {
        return;
    };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_uuid(stem) {
                continue;
            }
            let entry = cache
                .entry(path.clone())
                .or_insert_with(|| Transcript::new(stem.to_ascii_lowercase()));
            if let Err(e) = entry.refresh(&path) {
                tracing::debug!(path = %path.display(), error = %e, "skip transcript");
                continue;
            }
            seen.push(path);
        }
    }
}

/// One `~/.claude/sessions/<pid>.json` entry.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LiveEntry {
    pub pid: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "procStart")]
    pub proc_start: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Read the live registry. Only `*.json` files are opened.
pub fn read_registry(dir: &Path) -> Vec<LiveEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read(&p).ok())
        .filter_map(|b| serde_json::from_slice::<LiveEntry>(&b).ok())
        .collect()
}

/// Live Claude sessions by session id. A registry entry counts when its pid
/// exists and its recorded start time matches. Entries without a start time
/// require a `claude` CLI process.
pub fn claude_live(registry: &[LiveEntry], procs: &HashMap<u32, Proc>) -> HashMap<String, LiveInfo> {
    let mut out: HashMap<String, LiveInfo> = HashMap::new();
    for e in registry {
        let Some(p) = procs.get(&e.pid) else { continue };
        let matches = match e.proc_start.as_deref() {
            Some(start) => procs::normalize_lstart(start) == p.lstart,
            None => procs::is_claude_cli(p),
        };
        if !matches {
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

/// Claude Code adapter: every config dir under `home`.
pub struct ClaudeAdapter {
    home: PathBuf,
    transcripts: HashMap<PathBuf, Transcript>,
}

impl ClaudeAdapter {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            transcripts: HashMap::new(),
        }
    }
}

impl Adapter for ClaudeAdapter {
    fn harness(&self) -> Harness {
        Harness::ClaudeCode
    }

    fn scan(&mut self, ctx: &ScanCtx<'_>) -> Vec<RunRecord> {
        let config = config_dirs(&self.home);
        scan(&unique_subdirs(&config, "projects"), &mut self.transcripts);
        let registry: Vec<LiveEntry> = unique_subdirs(&config, "sessions")
            .iter()
            .flat_map(|d| read_registry(d))
            .collect();
        let live = claude_live(&registry, ctx.procs);

        let mut out = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for t in self.transcripts.values() {
            let cwd = t.cwd.clone().or_else(|| {
                registry
                    .iter()
                    .find(|e| e.session_id.eq_ignore_ascii_case(&t.session_id))
                    .and_then(|e| e.cwd.clone())
            });
            let Some(cwd) = cwd else { continue };
            seen.insert(t.session_id.clone());
            let updated = t
                .updated_at
                .as_deref()
                .and_then(parse_ts)
                .or_else(|| t.mtime.map(from_system))
                .unwrap_or(ctx.now);
            let mut r = RunRecord::new(Harness::ClaudeCode, t.session_id.clone(), cwd, updated);
            r.started = t.started_at.as_deref().and_then(parse_ts).unwrap_or(updated);
            r.title = t.title().unwrap_or_else(|| "(untitled)".into());
            r.name = t.agent_name.clone();
            r.git_branch = t.git_branch.clone();
            r.last_prompt = t.last_prompt.clone();
            r.pr = t.pr.clone();
            r.cost_usd = t.cost_usd;
            r.headless = t.headless();
            r.live = live.get(&t.session_id).cloned();
            out.push(r);
        }
        // A live session with no transcript yet (no message sent).
        for e in &registry {
            let id = e.session_id.to_ascii_lowercase();
            let (Some(info), Some(cwd)) = (live.get(&id), e.cwd.clone()) else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let mut r = RunRecord::new(Harness::ClaudeCode, id, cwd, ctx.now);
            r.title = e.name.clone().unwrap_or_else(|| "(new session)".into());
            r.name = e.name.clone();
            r.headless = e.kind.as_deref() == Some("bg");
            r.live = Some(info.clone());
            out.push(r);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonl::{HEAD_BYTES, TAIL_BYTES};
    use std::fs::File;
    use std::io::Write;

    const SID: &str = "26e3373e-8358-416b-83f3-355a59325193";

    fn lines() -> Vec<String> {
        vec![
            r#"{"type":"user","sessionId":"x","cwd":"/w/acme","gitBranch":"main","entrypoint":"cli","timestamp":"2026-11-11T16:22:22.378Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#.into(),
            r#"{"type":"user","cwd":"/w/acme","timestamp":"2026-11-11T16:22:30.000Z","message":{"role":"user","content":[{"type":"text","text":"Fix the flaky login test"}]}}"#.into(),
            r#"{"type":"assistant","cwd":"/w/acme","gitBranch":"fix/login","timestamp":"2026-11-11T16:23:00.000Z","message":{"content":[{"type":"text","text":"ok"}]}}"#.into(),
            r#"{"type":"custom-title","customTitle":"login-fix","sessionId":"x"}"#.into(),
            r#"{"type":"agent-name","agentName":"s-login","sessionId":"x"}"#.into(),
            r#"{"type":"last-prompt","lastPrompt":"now open the PR","sessionId":"x"}"#.into(),
            r#"{"type":"pr-link","prNumber":236,"prUrl":"https://github.com/acme/api/pull/236","prRepository":"acme/api"}"#.into(),
            r#"{"type":"cost-state","totalCostUSD":8.48,"startTime":1794414118024}"#.into(),
            r#"not json"#.into(),
        ]
    }

    fn write(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join(format!("{SID}.jsonl"));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn parses_summary_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write(tmp.path(), &(lines().join("\n") + "\n"));
        let mut t = Transcript::new(SID);
        t.refresh(&p).unwrap();
        assert_eq!(t.cwd.as_deref(), Some("/w/acme"));
        assert_eq!(t.git_branch.as_deref(), Some("fix/login"));
        assert_eq!(t.started_at.as_deref(), Some("2026-11-11T16:22:22.378Z"));
        assert_eq!(t.updated_at.as_deref(), Some("2026-11-11T16:23:00.000Z"));
        assert_eq!(t.first_prompt.as_deref(), Some("Fix the flaky login test"));
        assert_eq!(t.last_prompt.as_deref(), Some("now open the PR"));
        assert_eq!(t.title().as_deref(), Some("login-fix"));
        assert_eq!(t.agent_name.as_deref(), Some("s-login"));
        assert_eq!(t.pr.as_ref().map(|p| p.number), Some(236));
        assert_eq!(t.cost_usd, Some(8.48));
        assert!(!t.headless());
    }

    #[test]
    fn appends_incrementally_and_ignores_partial_line() {
        let tmp = tempfile::tempdir().unwrap();
        let all = lines();
        let p = write(tmp.path(), &(all[..3].join("\n") + "\n" + r#"{"type":"last-pro"#));
        let mut t = Transcript::new(SID);
        t.refresh(&p).unwrap();
        assert_eq!(t.last_prompt, None);

        // The writer finishes the partial line and appends the rest.
        std::fs::write(&p, all.join("\n") + "\n").unwrap();
        t.refresh(&p).unwrap();
        assert_eq!(t.last_prompt.as_deref(), Some("now open the PR"));
        assert_eq!(t.first_prompt.as_deref(), Some("Fix the flaky login test"));
    }

    #[test]
    fn large_file_reads_head_and_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(format!("{SID}.jsonl"));
        let mut f = File::create(&p).unwrap();
        let all = lines();
        writeln!(f, "{}", all[0]).unwrap();
        writeln!(f, "{}", all[1]).unwrap();
        let filler = format!(
            r#"{{"type":"assistant","timestamp":"2026-11-11T17:00:00.000Z","message":{{"content":"{}"}}}}"#,
            "x".repeat(4000)
        );
        for _ in 0..400 {
            writeln!(f, "{filler}").unwrap();
        }
        for l in &all[3..] {
            writeln!(f, "{l}").unwrap();
        }
        drop(f);
        assert!(std::fs::metadata(&p).unwrap().len() > HEAD_BYTES + TAIL_BYTES);

        let mut t = Transcript::new(SID);
        t.refresh(&p).unwrap();
        assert_eq!(t.first_prompt.as_deref(), Some("Fix the flaky login test"));
        assert_eq!(t.title().as_deref(), Some("login-fix"));
        assert_eq!(t.updated_at.as_deref(), Some("2026-11-11T17:00:00.000Z"));
    }

    #[test]
    fn scan_visits_top_level_uuid_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-w-acme");
        std::fs::create_dir_all(proj.join(SID).join("subagents")).unwrap();
        std::fs::write(proj.join(format!("{SID}.jsonl")), lines().join("\n") + "\n").unwrap();
        std::fs::write(proj.join("notes.jsonl"), "{}\n").unwrap();
        std::fs::write(
            proj.join(SID).join("subagents").join("agent-1.jsonl"),
            "{}\n",
        )
        .unwrap();
        let mut cache = HashMap::new();
        let roots = vec![tmp.path().to_path_buf()];
        scan(&roots, &mut cache);
        assert_eq!(cache.len(), 1);

        std::fs::remove_file(proj.join(format!("{SID}.jsonl"))).unwrap();
        scan(&roots, &mut cache);
        assert!(cache.is_empty());
    }

    #[test]
    fn discovers_config_dirs_and_dedupes_symlinked_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let main = home.join(".claude");
        std::fs::create_dir_all(main.join("projects")).unwrap();
        std::fs::create_dir_all(main.join("sessions")).unwrap();
        let client = main.join("clients").join("acme");
        std::fs::create_dir_all(client.join("sessions")).unwrap();
        std::os::unix::fs::symlink(main.join("projects"), client.join("projects")).unwrap();
        let other = home.join(".config").join("claude").join("work");
        std::fs::create_dir_all(other.join("projects")).unwrap();
        let alt = home.join(".claude-alt");
        std::fs::create_dir_all(alt.join("sessions")).unwrap();
        std::fs::create_dir_all(home.join(".claude-empty")).unwrap();

        let dirs = config_dirs(home);
        assert_eq!(dirs.len(), 4, "{dirs:?}");
        assert_eq!(unique_subdirs(&dirs, "projects").len(), 2);
        assert_eq!(unique_subdirs(&dirs, "sessions").len(), 3);
    }

    #[test]
    fn registry_reads_json_and_never_key_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("34455.json"),
            r#"{"pid":34455,"sessionId":"26e3373e-8358-416b-83f3-355a59325193","cwd":"/w/acme","status":"busy","procStart":"Fri Nov 27 10:30:03 2026","kind":"interactive"}"#,
        )
        .unwrap();
        // A .key file with JSON-looking content must still be ignored.
        std::fs::write(
            tmp.path().join("34455.abc.key"),
            r#"{"pid":1,"sessionId":"secret"}"#,
        )
        .unwrap();
        let live = read_registry(tmp.path());
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].pid, 34455);
        assert_eq!(live[0].status.as_deref(), Some("busy"));
    }
}
