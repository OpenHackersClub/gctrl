//! Pi coding agent reader: session files under
//! `<agent dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl` (agent dir
//! `~/.pi/agent`, overridden by `PI_CODING_AGENT_DIR`; the sessions dir by
//! `PI_CODING_AGENT_SESSION_DIR`).
//!
//! The first line is the `session` header (`id`, `cwd`, `timestamp`). Later
//! lines are entries: `message` (with `message.role`), `session_info`
//! (`name`), `model_change` (`modelId`). Files are read incrementally
//! through [`crate::jsonl::Cursor`].

use crate::adapter::{
    from_system, match_processes, parse_ts, Adapter, Candidate, RunRecord, ScanCtx,
};
use crate::jsonl::{message_text, Cursor};
use crate::model::{Harness, LiveInfo, LiveStatus};
use crate::procs;
use crate::text::{clip, is_human_prompt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct PiSession {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub name: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub model: Option<String>,
    pub last_role: Option<String>,
    pub last_stop_reason: Option<String>,
    cursor: Cursor,
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl PiSession {
    fn ingest(&mut self, raw: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            return;
        };
        let ts = str_at(&v, "timestamp").map(str::to_string);
        match str_at(&v, "type") {
            Some("session") => {
                self.id = str_at(&v, "id").map(str::to_string);
                self.cwd = str_at(&v, "cwd").map(str::to_string);
                self.started_at = ts.clone();
            }
            Some("session_info") => {
                if let Some(n) = str_at(&v, "name") {
                    self.name = Some(n.to_string());
                }
            }
            Some("model_change") => {
                if let Some(m) = str_at(&v, "modelId") {
                    self.model = Some(m.to_string());
                }
            }
            Some("message") => {
                let Some(m) = v.get("message") else { return };
                let role = str_at(m, "role").unwrap_or("");
                match role {
                    "user" => {
                        let text = m.get("content").and_then(message_text);
                        if let Some(t) = text.filter(|t| is_human_prompt(t)) {
                            if self.first_prompt.is_none() {
                                self.first_prompt = Some(clip(&t, 120));
                            }
                            self.last_prompt = Some(clip(&t, 200));
                        }
                    }
                    "assistant" => {
                        if let Some(model) = str_at(m, "model") {
                            self.model = Some(model.to_string());
                        }
                    }
                    _ => {}
                }
                if matches!(role, "user" | "assistant" | "toolResult") {
                    self.last_role = Some(role.to_string());
                    self.last_stop_reason = str_at(m, "stopReason").map(str::to_string);
                }
            }
            _ => {}
        }
        if let Some(ts) = ts {
            if self
                .updated_at
                .as_deref()
                .is_none_or(|cur| ts.as_str() > cur)
            {
                self.updated_at = Some(ts);
            }
        }
    }

    pub fn refresh(&mut self, path: &Path) -> std::io::Result<()> {
        let Some(update) = self.cursor.read(path)? else {
            return Ok(());
        };
        if update.reset {
            let cursor = std::mem::take(&mut self.cursor);
            *self = PiSession {
                cursor,
                ..PiSession::default()
            };
        }
        for line in &update.lines {
            self.ingest(line);
        }
        Ok(())
    }

    /// A turn is open while the newest message awaits a model or tool reply.
    pub fn turn_open(&self) -> bool {
        match self.last_role.as_deref() {
            Some("user") | Some("toolResult") => true,
            Some("assistant") => self.last_stop_reason.as_deref() == Some("toolUse"),
            _ => false,
        }
    }
}

/// `<timestamp>_<id>` file stem → id.
fn id_from_stem(stem: &str) -> Option<&str> {
    stem.split_once('_')
        .map(|(_, id)| id)
        .filter(|id| !id.is_empty())
}

/// Pi adapter over one sessions directory.
pub struct PiAdapter {
    sessions_dir: PathBuf,
    files: HashMap<PathBuf, PiSession>,
}

impl PiAdapter {
    pub fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir,
            files: HashMap::new(),
        }
    }

    fn scan_files(&mut self) {
        let mut seen = HashSet::new();
        let Ok(dirs) = std::fs::read_dir(&self.sessions_dir) else {
            self.files.clear();
            return;
        };
        for dir in dirs.flatten() {
            let Ok(files) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let entry = self.files.entry(path.clone()).or_default();
                if let Err(e) = entry.refresh(&path) {
                    tracing::debug!(path = %path.display(), error = %e, "skip pi session");
                    continue;
                }
                seen.insert(path);
            }
        }
        self.files.retain(|p, _| seen.contains(p));
    }
}

impl Adapter for PiAdapter {
    fn harness(&self) -> Harness {
        Harness::Pi
    }

    fn scan(&mut self, ctx: &ScanCtx<'_>) -> Vec<RunRecord> {
        self.scan_files();
        struct Row<'a> {
            id: String,
            cwd: String,
            s: &'a PiSession,
        }
        let rows: Vec<Row<'_>> = self
            .files
            .iter()
            .filter_map(|(path, s)| {
                let stem = path.file_stem()?.to_str()?;
                let id =
                    s.id.clone()
                        .or_else(|| id_from_stem(stem).map(str::to_string))?;
                Some(Row {
                    id,
                    cwd: s.cwd.clone()?,
                    s,
                })
            })
            .collect();
        let updated = |r: &Row<'_>| {
            r.s.updated_at
                .as_deref()
                .and_then(parse_ts)
                .or_else(|| r.s.cursor.mtime().map(from_system))
                .unwrap_or(ctx.now)
        };
        let cands: Vec<Candidate<'_>> = rows
            .iter()
            .map(|r| Candidate {
                alias: &r.id,
                run: &r.id,
                cwd: &r.cwd,
                updated_ms: updated(r).timestamp_millis(),
                interactive: true,
            })
            .collect();
        let live = match_processes(&cands, ctx.procs, procs::is_pi_cli, procs::cwds);

        rows.iter()
            .map(|row| {
                let up = updated(row);
                let mut r = RunRecord::new(Harness::Pi, row.id.clone(), row.cwd.clone(), up);
                r.started = row.s.started_at.as_deref().and_then(parse_ts).unwrap_or(up);
                r.title = row
                    .s
                    .name
                    .clone()
                    .or_else(|| row.s.first_prompt.clone())
                    .unwrap_or_else(|| "(untitled)".into());
                r.name = row.s.name.clone();
                r.last_prompt = row.s.last_prompt.clone();
                r.model = row.s.model.clone();
                r.live = live.get(&row.id).map(|pid| LiveInfo {
                    pid: *pid,
                    tty: ctx.procs.get(pid).and_then(|p| p.tty.clone()),
                    status: if row.s.turn_open() {
                        LiveStatus::Busy
                    } else {
                        LiveStatus::Idle
                    },
                });
                r
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const PI_ID: &str = "019a0b7c-1d2e-7f30-8a41-5b6c7d8e9f01";

    pub fn write_session(root: &Path, cwd: &str) -> PathBuf {
        let dir = root.join(format!(
            "--{}--",
            cwd.trim_start_matches('/').replace('/', "-")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("2026-11-27T10-00-00-000Z_{PI_ID}.jsonl"));
        let lines = [
            format!(r#"{{"type":"session","version":3,"id":"{PI_ID}","timestamp":"2026-11-27T10:00:00.000Z","cwd":"{cwd}"}}"#),
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-27T10:00:01.000Z","message":{"role":"user","content":"refactor the parser","timestamp":1795600801000}}"#.to_string(),
            r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-11-27T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-opus-5-5","stopReason":"toolUse"}}"#.to_string(),
            r#"{"type":"session_info","id":"a3","parentId":"a2","timestamp":"2026-11-27T10:00:06.000Z","name":"parser-refactor"}"#.to_string(),
            r#"{"type":"message","id":"a4","parentId":"a3","timestamp":"2026-11-27T10:00:09.000Z","message":{"role":"user","content":[{"type":"text","text":"also update docs"}]}}"#.to_string(),
            r#"{"type":"message","id":"a5","parentId":"a4","timestamp":"2026-11-27T10:00:20.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}"#.to_string(),
        ];
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }

    #[test]
    fn reads_session_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_session(tmp.path(), "/w/api");
        let mut s = PiSession::default();
        s.refresh(&p).unwrap();
        assert_eq!(s.id.as_deref(), Some(PI_ID));
        assert_eq!(s.cwd.as_deref(), Some("/w/api"));
        assert_eq!(s.name.as_deref(), Some("parser-refactor"));
        assert_eq!(s.first_prompt.as_deref(), Some("refactor the parser"));
        assert_eq!(s.last_prompt.as_deref(), Some("also update docs"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(s.updated_at.as_deref(), Some("2026-11-27T10:00:20.000Z"));
        assert!(!s.turn_open());
    }

    #[test]
    fn adapter_builds_records() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "/w/api");
        let procs = HashMap::new();
        let ctx = ScanCtx {
            procs: &procs,
            now: chrono::Utc::now(),
        };
        let mut a = PiAdapter::new(tmp.path().to_path_buf());
        let recs = a.scan(&ctx);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].native_id, PI_ID);
        assert_eq!(recs[0].title, "parser-refactor");
        assert_eq!(id_from_stem("2026-11-27T10-00-00-000Z_abc"), Some("abc"));
    }
}
