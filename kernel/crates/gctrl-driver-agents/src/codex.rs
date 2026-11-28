//! Codex reader: `threads` in `~/.codex/state_<n>.sqlite`, plus the tail of
//! each thread's rollout file for the last human prompt.
//!
//! The database opens through [`crate::sqlite_ro`]. The reader never writes.

use crate::text::{clip, is_human_prompt};
use crate::adapter::{from_ms, match_processes, Adapter, Candidate, RunRecord, ScanCtx};
use crate::model::{Harness, LiveInfo, LiveStatus};
use crate::procs;
use crate::sqlite_ro::{columns, open};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const ROLLOUT_TAIL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Thread {
    pub id: String,
    pub rollout_path: String,
    pub cwd: String,
    pub title: String,
    pub name: Option<String>,
    pub first_user_message: Option<String>,
    pub git_branch: Option<String>,
    pub git_origin_url: Option<String>,
    pub tokens_used: i64,
    pub model: Option<String>,
    pub archived: bool,
    pub source: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl Thread {
    pub fn headless(&self) -> bool {
        self.source == "exec"
    }

    pub fn display_title(&self) -> String {
        self.name
            .clone()
            .filter(|n| !n.is_empty())
            .or_else(|| Some(clip(&self.title, 120)).filter(|t| !t.is_empty()))
            .or_else(|| self.first_user_message.as_deref().map(|m| clip(m, 120)))
            .unwrap_or_else(|| "(untitled)".into())
    }
}

/// The highest-numbered `state_<n>.sqlite` under `codex_home`.
pub fn find_state_db(codex_home: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(codex_home).ok()?;
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let n: u32 = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse()
                .ok()?;
            Some((n, e.path()))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, p)| p)
}

/// Interactive and headless user threads. Guardian reviews and subagent
/// threads (`thread_source` other than `user`) are excluded.
pub fn read_threads(db: &Path) -> rusqlite::Result<Vec<Thread>> {
    let c = open(db)?;
    let cols = columns(&c, "threads")?;
    let has = |n: &str| cols.iter().any(|c| c == n);
    let opt = |n: &str| if has(n) { n.to_string() } else { "NULL".to_string() };
    let ms = |n: &str, secs: &str| {
        if has(n) {
            format!("COALESCE({n}, {secs} * 1000)")
        } else {
            format!("{secs} * 1000")
        }
    };
    let where_source = if has("thread_source") {
        "WHERE (thread_source IS NULL OR thread_source = 'user')"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, rollout_path, cwd, title, {name}, {first}, {branch}, {origin}, \
         tokens_used, {model}, archived, source, {created}, {updated} \
         FROM threads {where_source}",
        name = opt("name"),
        first = opt("first_user_message"),
        branch = opt("git_branch"),
        origin = opt("git_origin_url"),
        model = opt("model"),
        created = ms("created_at_ms", "created_at"),
        updated = ms("updated_at_ms", "updated_at"),
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(Thread {
            id: r.get::<_, String>(0)?.to_ascii_lowercase(),
            rollout_path: r.get(1)?,
            cwd: r.get(2)?,
            title: r.get(3)?,
            name: r.get(4)?,
            first_user_message: r.get(5)?,
            git_branch: r.get(6)?,
            git_origin_url: r.get(7)?,
            tokens_used: r.get(8)?,
            model: r.get(9)?,
            archived: r.get::<_, i64>(10)? != 0,
            source: r.get(11)?,
            created_at_ms: r.get(12)?,
            updated_at_ms: r.get(13)?,
        })
    })?;
    rows.collect()
}

/// What the tail of a rollout file says about its thread.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RolloutTail {
    pub last_prompt: Option<String>,
    /// `Some(true)` while a turn has started and not completed.
    pub turn_open: Option<bool>,
}

fn tail_text(rollout: &Path) -> Option<String> {
    let mut f = std::fs::File::open(rollout).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(ROLLOUT_TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Last human prompt and turn state, read from a rollout's tail.
pub fn read_tail(rollout: &Path) -> RolloutTail {
    let Some(text) = tail_text(rollout) else {
        return RolloutTail::default();
    };
    let last_prompt = text
        .lines()
        .rev()
        .filter(|l| l.contains(r#""role":"user""#))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let content = v.get("payload")?.get("content")?.as_array()?;
            let first = content
                .iter()
                .find_map(|c| c.get("text").and_then(Value::as_str))?;
            is_human_prompt(first).then(|| clip(first, 200))
        })
        .next();
    let turn_open = text.lines().rev().find_map(|l| {
        if !l.contains(r#""type":"event_msg""#) {
            return None;
        }
        if l.contains(r#""type":"task_started""#) {
            Some(true)
        } else if l.contains(r#""type":"task_complete""#) || l.contains(r#""type":"turn_aborted""#) {
            Some(false)
        } else {
            None
        }
    });
    RolloutTail { last_prompt, turn_open }
}

/// Last human prompt in a rollout file, read from its tail.
pub fn last_prompt(rollout: &Path) -> Option<String> {
    read_tail(rollout).last_prompt
}

/// Per-path cache of [`RolloutTail`] keyed by mtime.
#[derive(Default)]
pub struct RolloutCache {
    entries: HashMap<PathBuf, (Option<SystemTime>, RolloutTail)>,
}

impl RolloutCache {
    pub fn mtime(path: &Path) -> Option<SystemTime> {
        std::fs::metadata(path).and_then(|m| m.modified()).ok()
    }

    pub fn tail(&mut self, path: &Path) -> RolloutTail {
        let mtime = Self::mtime(path);
        if let Some((m, t)) = self.entries.get(path) {
            if *m == mtime {
                return t.clone();
            }
        }
        let t = read_tail(path);
        self.entries.insert(path.to_path_buf(), (mtime, t.clone()));
        t
    }
}

/// A rollout written this recently means a turn is in progress, when the
/// tail carries no turn event.
const BUSY_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

/// Codex adapter: `threads` in the newest state database under `codex_home`.
pub struct CodexAdapter {
    codex_home: PathBuf,
    rollouts: RolloutCache,
}

impl CodexAdapter {
    pub fn new(codex_home: PathBuf) -> Self {
        Self {
            codex_home,
            rollouts: RolloutCache::default(),
        }
    }
}

impl Adapter for CodexAdapter {
    fn harness(&self) -> Harness {
        Harness::Codex
    }

    fn scan(&mut self, ctx: &ScanCtx<'_>) -> Vec<RunRecord> {
        let threads = find_state_db(&self.codex_home)
            .map(|db| {
                read_threads(&db).unwrap_or_else(|e| {
                    tracing::warn!(db = %db.display(), error = %e, "codex threads unreadable");
                    Vec::new()
                })
            })
            .unwrap_or_default();
        let cands: Vec<Candidate<'_>> = threads
            .iter()
            .map(|t| Candidate {
                alias: &t.id,
                run: &t.id,
                cwd: &t.cwd,
                updated_ms: t.updated_at_ms,
                interactive: !t.headless(),
            })
            .collect();
        let live = match_processes(&cands, ctx.procs, procs::is_codex_cli, procs::cwds);

        threads
            .iter()
            .map(|t| {
                let rollout = PathBuf::from(&t.rollout_path);
                let updated = from_ms(t.updated_at_ms);
                let pid = live.get(&t.id).copied();
                let tail = if !t.headless() && ctx.wants_detail(pid.is_some(), updated) {
                    self.rollouts.tail(&rollout)
                } else {
                    RolloutTail::default()
                };
                let mut r = RunRecord::new(Harness::Codex, t.id.clone(), t.cwd.clone(), updated);
                r.started = from_ms(t.created_at_ms);
                r.title = t.display_title();
                r.name = t.name.clone().filter(|n| !n.is_empty());
                r.origin = t.git_origin_url.clone();
                r.git_branch = t.git_branch.clone();
                r.last_prompt = tail.last_prompt.clone();
                r.tokens = Some(t.tokens_used);
                r.model = t.model.clone();
                r.headless = t.headless();
                r.archived = t.archived;
                r.live = pid.map(|pid| {
                    let recent = RolloutCache::mtime(&rollout)
                        .and_then(|m| SystemTime::now().duration_since(m).ok())
                        .is_some_and(|age| age < BUSY_WINDOW);
                    let busy = tail.turn_open.unwrap_or(recent);
                    LiveInfo {
                        pid,
                        tty: ctx.procs.get(&pid).and_then(|p| p.tty.clone()),
                        status: if busy { LiveStatus::Busy } else { LiveStatus::Idle },
                    }
                });
                r
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn make_db(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE threads (
               id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL,
               title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
               archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT, git_origin_url TEXT,
               first_user_message TEXT NOT NULL DEFAULT '', model TEXT,
               updated_at_ms INTEGER, created_at_ms INTEGER, name TEXT, thread_source TEXT);
             INSERT INTO threads VALUES ('01A04C15-4628-7913-BD1D-21ED78284C55','/r/1.jsonl',100,200,'cli','/w/acme','fix login',42,0,'main','git@github.com:acme/api.git','fix login','gpt-5',200500,NULL,'Fix login','user');
             INSERT INTO threads VALUES ('11111111-1111-1111-1111-111111111111','/r/2.jsonl',100,300,'exec','/w/acme','batch',1,0,NULL,NULL,'',NULL,NULL,NULL,NULL,'user');
             INSERT INTO threads VALUES ('22222222-2222-2222-2222-222222222222','/r/3.jsonl',100,300,'{\"subagent\":\"review\"}','/w/acme','review',1,0,NULL,NULL,'',NULL,NULL,NULL,NULL,'subagent');",
        )
        .unwrap();
        drop(c);
        p
    }

    #[test]
    fn finds_highest_state_db() {
        let tmp = tempfile::tempdir().unwrap();
        for n in ["state_3.sqlite", "state_5.sqlite", "state_5.sqlite-wal", "logs_9.sqlite"] {
            std::fs::write(tmp.path().join(n), "").unwrap();
        }
        assert_eq!(
            find_state_db(tmp.path()),
            Some(tmp.path().join("state_5.sqlite"))
        );
    }

    #[test]
    fn reads_user_threads_without_wal_index() {
        let tmp = tempfile::tempdir().unwrap();
        let db = make_db(tmp.path(), "state_5.sqlite");
        // A clean close removes -wal/-shm, which forces the immutable path.
        assert!(!tmp.path().join("state_5.sqlite-shm").exists());
        let mut threads = read_threads(&db).unwrap();
        threads.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(threads.len(), 2);
        let t = &threads[0];
        assert_eq!(t.id, "01a04c15-4628-7913-bd1d-21ed78284c55");
        assert_eq!(t.display_title(), "Fix login");
        assert_eq!(t.updated_at_ms, 200500);
        assert_eq!(t.created_at_ms, 100_000);
        assert!(!t.headless());
        assert!(threads[1].headless());
    }

    #[test]
    fn last_prompt_skips_injected_context() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &p,
            [
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first ask"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second ask"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(last_prompt(&p).as_deref(), Some("second ask"));
    }

    #[test]
    fn turn_state_from_last_turn_event() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("rollout.jsonl");
        let started = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        let tokens = r#"{"type":"event_msg","payload":{"type":"token_count"}}"#;
        std::fs::write(&p, [started, done, started, tokens].join("\n")).unwrap();
        assert_eq!(read_tail(&p).turn_open, Some(true));
        std::fs::write(&p, [started, tokens, done, tokens].join("\n")).unwrap();
        assert_eq!(read_tail(&p).turn_open, Some(false));
        std::fs::write(&p, tokens).unwrap();
        assert_eq!(read_tail(&p).turn_open, None);
    }
}
