//! Codex reader: `threads` in `~/.codex/state_<n>.sqlite`, plus the tail of
//! each thread's rollout file for the last human prompt.
//!
//! The database is opened with `mode=ro`. When Codex is not running its WAL
//! index (`-shm`) is absent and a read-only connection cannot create one, so
//! the reader falls back to `immutable=1`; with no `-wal` file present the
//! main file holds every committed write. The reader never writes.

use crate::text::{clip, is_human_prompt};
use rusqlite::{Connection, OpenFlags};
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

fn open(db: &Path) -> rusqlite::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let base = format!("file:{}", db.display());
    let try_open = |uri: String| -> rusqlite::Result<Connection> {
        let c = Connection::open_with_flags(uri, flags)?;
        c.busy_timeout(std::time::Duration::from_millis(500))?;
        // Opening is lazy; touch the schema so a missing WAL index fails here.
        c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
        Ok(c)
    };
    try_open(format!("{base}?mode=ro")).or_else(|_| try_open(format!("{base}?immutable=1")))
}

fn columns(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = c.prepare("PRAGMA table_info(threads)")?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// Interactive and headless user threads. Guardian reviews and subagent
/// threads (`thread_source` other than `user`) are excluded.
pub fn read_threads(db: &Path) -> rusqlite::Result<Vec<Thread>> {
    let c = open(db)?;
    let cols = columns(&c)?;
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

/// Last human prompt in a rollout file, read from its tail.
pub fn last_prompt(rollout: &Path) -> Option<String> {
    let mut f = std::fs::File::open(rollout).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(ROLLOUT_TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines()
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
        .next()
}

/// Rollout mtime, and a per-path cache of the last prompt keyed by mtime.
#[derive(Default)]
pub struct RolloutCache {
    entries: HashMap<PathBuf, (Option<SystemTime>, Option<String>)>,
}

impl RolloutCache {
    pub fn mtime(path: &Path) -> Option<SystemTime> {
        std::fs::metadata(path).and_then(|m| m.modified()).ok()
    }

    pub fn last_prompt(&mut self, path: &Path) -> Option<String> {
        let mtime = Self::mtime(path);
        if let Some((m, p)) = self.entries.get(path) {
            if *m == mtime {
                return p.clone();
            }
        }
        let p = last_prompt(path);
        self.entries.insert(path.to_path_buf(), (mtime, p.clone()));
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
