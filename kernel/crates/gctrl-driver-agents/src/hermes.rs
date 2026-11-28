//! Hermes Agent reader: `sessions` and `messages` in `<hermes home>/state.db`
//! (default `~/.hermes`, overridden by `HERMES_HOME`).
//!
//! Context compression ends a session with `end_reason = 'compression'` and
//! continues in a child session (`parent_session_id`). A chain shows as one
//! run: the newest session in the chain, with the chain's start time and
//! first prompt. The database opens through [`crate::sqlite_ro`]; the reader
//! never writes.

use crate::adapter::{from_secs_f64, match_processes, Adapter, Candidate, RunRecord, ScanCtx};
use crate::model::{Harness, LiveInfo, LiveStatus};
use crate::procs;
use crate::sqlite_ro::{columns, open};
use crate::text::{clip, is_human_prompt};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Session {
    pub id: String,
    pub source: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: f64,
    pub ended_at: Option<f64>,
    pub end_reason: Option<String>,
    pub parent: Option<String>,
    pub archived: bool,
    pub tokens: i64,
    pub cost_usd: Option<f64>,
    pub last_message_at: Option<f64>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    /// Role of the newest message, and whether it carries tool calls.
    pub last_role: Option<String>,
    pub last_has_tool_calls: bool,
}

impl Session {
    /// Gateway sessions (Telegram, Discord, cron, API) have no terminal.
    pub fn headless(&self) -> bool {
        !matches!(self.source.as_str(), "cli" | "tui")
    }

    fn compressed(&self) -> bool {
        self.end_reason.as_deref() == Some("compression")
    }

    /// A turn is open while the newest message awaits a model or tool reply.
    pub fn turn_open(&self) -> bool {
        match self.last_role.as_deref() {
            Some("user") | Some("tool") => true,
            Some("assistant") => self.last_has_tool_calls,
            _ => false,
        }
    }
}

/// Every session row with its message summary.
pub fn read_sessions(db: &Path) -> rusqlite::Result<Vec<Session>> {
    let c = open(db)?;
    let cols = columns(&c, "sessions")?;
    let has = |n: &str| cols.iter().any(|c| c == n);
    let opt = |n: &str| {
        if has(n) {
            format!("s.{n}")
        } else {
            "NULL".to_string()
        }
    };
    let msg_cols = columns(&c, "messages")?;
    let active = if msg_cols.iter().any(|c| c == "active") {
        " AND m.active = 1"
    } else {
        ""
    };
    let cost = match (has("actual_cost_usd"), has("estimated_cost_usd")) {
        (true, true) => "COALESCE(s.actual_cost_usd, s.estimated_cost_usd)",
        (true, false) => "s.actual_cost_usd",
        (false, true) => "s.estimated_cost_usd",
        _ => "NULL",
    };
    let tokens = if has("input_tokens") && has("output_tokens") {
        "COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0)"
    } else {
        "0"
    };
    let sql = format!(
        "SELECT s.id, s.source, {cwd}, {title}, {model}, s.started_at, {ended}, {reason}, \
           {parent}, {archived}, {tokens}, {cost}, \
           (SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id{active}), \
           (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'{active} \
              ORDER BY m.timestamp ASC, m.id ASC LIMIT 1), \
           (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'{active} \
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1), \
           (SELECT m.role FROM messages m WHERE m.session_id = s.id{active} \
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1), \
           (SELECT m.tool_calls IS NOT NULL AND m.tool_calls NOT IN ('', '[]', 'null') \
              FROM messages m WHERE m.session_id = s.id{active} \
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) \
         FROM sessions s",
        cwd = opt("cwd"),
        title = opt("title"),
        model = opt("model"),
        ended = opt("ended_at"),
        reason = opt("end_reason"),
        parent = opt("parent_session_id"),
        archived = if has("archived") { "s.archived" } else { "0" },
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let prompt =
            |v: Option<String>, max: usize| v.filter(|t| is_human_prompt(t)).map(|t| clip(&t, max));
        Ok(Session {
            id: r.get(0)?,
            source: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            cwd: r.get::<_, Option<String>>(2)?.filter(|c| !c.is_empty()),
            title: r.get::<_, Option<String>>(3)?.filter(|t| !t.is_empty()),
            model: r.get(4)?,
            started_at: r.get(5)?,
            ended_at: r.get(6)?,
            end_reason: r.get(7)?,
            parent: r.get(8)?,
            archived: r.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
            tokens: r.get::<_, Option<i64>>(10)?.unwrap_or(0),
            cost_usd: r.get(11)?,
            last_message_at: r.get(12)?,
            first_prompt: prompt(r.get(13)?, 120),
            last_prompt: prompt(r.get(14)?, 200),
            last_role: r.get(15)?,
            last_has_tool_calls: r.get::<_, Option<bool>>(16)?.unwrap_or(false),
        })
    })?;
    rows.collect()
}

/// One run per compression chain: the newest session, plus the ids of the
/// sessions it continues (oldest first).
pub fn chains(sessions: &[Session]) -> Vec<(&Session, Vec<&str>)> {
    let by_id: HashMap<&str, &Session> = sessions.iter().map(|s| (s.id.as_str(), s)).collect();
    let continued: std::collections::HashSet<&str> = sessions
        .iter()
        .filter_map(|s| {
            let p = by_id.get(s.parent.as_deref()?)?;
            p.compressed().then_some(p.id.as_str())
        })
        .collect();
    sessions
        .iter()
        .filter(|s| !continued.contains(s.id.as_str()))
        .map(|leaf| {
            let mut ancestors = Vec::new();
            let mut cur = leaf;
            while let Some(p) = cur.parent.as_deref().and_then(|p| by_id.get(p)) {
                if !p.compressed() || ancestors.len() > 256 {
                    break;
                }
                ancestors.push(p.id.as_str());
                cur = p;
            }
            ancestors.reverse();
            (leaf, ancestors)
        })
        .collect()
}

/// Hermes adapter over `<home>/state.db`.
pub struct HermesAdapter {
    hermes_home: PathBuf,
    /// Working directory for sessions that recorded none.
    fallback_cwd: String,
}

impl HermesAdapter {
    pub fn new(hermes_home: PathBuf, fallback_cwd: String) -> Self {
        Self {
            hermes_home,
            fallback_cwd,
        }
    }
}

impl Adapter for HermesAdapter {
    fn harness(&self) -> Harness {
        Harness::Hermes
    }

    fn scan(&mut self, ctx: &ScanCtx<'_>) -> Vec<RunRecord> {
        let db = self.hermes_home.join("state.db");
        if !db.is_file() {
            return Vec::new();
        }
        let sessions = read_sessions(&db).unwrap_or_else(|e| {
            tracing::warn!(db = %db.display(), error = %e, "hermes sessions unreadable");
            Vec::new()
        });
        let by_id: HashMap<&str, &Session> = sessions.iter().map(|s| (s.id.as_str(), s)).collect();
        let chains = chains(&sessions);
        let cwd_of = |s: &Session| s.cwd.clone().unwrap_or_else(|| self.fallback_cwd.clone());
        let cwds: Vec<String> = chains.iter().map(|(leaf, _)| cwd_of(leaf)).collect();
        let updated_ms = |s: &Session| {
            (s.last_message_at.or(s.ended_at).unwrap_or(s.started_at) * 1000.0) as i64
        };
        let mut cands = Vec::new();
        for ((leaf, ancestors), cwd) in chains.iter().zip(&cwds) {
            for alias in std::iter::once(leaf.id.as_str()).chain(ancestors.iter().copied()) {
                cands.push(Candidate {
                    alias,
                    run: &leaf.id,
                    cwd,
                    updated_ms: updated_ms(leaf),
                    interactive: !leaf.headless(),
                });
            }
        }
        let live = match_processes(&cands, ctx.procs, procs::is_hermes_cli, procs::cwds);

        chains
            .iter()
            .zip(cwds)
            .map(|((leaf, ancestors), cwd)| {
                let root = ancestors
                    .first()
                    .and_then(|id| by_id.get(id))
                    .copied()
                    .unwrap_or(leaf);
                let updated = from_secs_f64(updated_ms(leaf) as f64 / 1000.0);
                let mut r = RunRecord::new(Harness::Hermes, leaf.id.clone(), cwd, updated);
                r.identity = root.id.clone();
                r.started = from_secs_f64(root.started_at);
                let first_prompt = root
                    .first_prompt
                    .clone()
                    .or_else(|| leaf.first_prompt.clone());
                r.title = leaf
                    .title
                    .clone()
                    .or_else(|| root.title.clone())
                    .or(first_prompt)
                    .unwrap_or_else(|| "(untitled)".into());
                r.name = leaf.title.clone().or_else(|| root.title.clone());
                r.last_prompt = leaf.last_prompt.clone();
                r.cost_usd = leaf.cost_usd;
                r.tokens = Some(leaf.tokens).filter(|t| *t > 0);
                r.model = leaf.model.clone();
                r.headless = leaf.headless();
                r.archived = leaf.archived;
                r.live = live.get(&leaf.id).map(|pid| LiveInfo {
                    pid: *pid,
                    tty: ctx.procs.get(pid).and_then(|p| p.tty.clone()),
                    status: if leaf.turn_open() {
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
    use rusqlite::Connection;

    pub fn make_db(dir: &Path) -> PathBuf {
        let p = dir.join("state.db");
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT,
               parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
               input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
               estimated_cost_usd REAL, actual_cost_usd REAL, title TEXT, cwd TEXT,
               archived INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
               role TEXT NOT NULL, content TEXT, tool_calls TEXT, timestamp REAL NOT NULL,
               active INTEGER NOT NULL DEFAULT 1);
             INSERT INTO sessions VALUES ('20260420_134942_1fd941','cli','m1',NULL,1776664182,1776664188,'compression',10,5,0.01,NULL,NULL,'/w/api',0);
             INSERT INTO sessions VALUES ('20260420_134952_7ed74f','cli','m1','20260420_134942_1fd941',1776664192,NULL,NULL,100,50,0.02,0.03,'fix-login','/w/api',0);
             INSERT INTO sessions VALUES ('20260623_050048_4ef4b9','telegram','m2',NULL,1782162049,NULL,NULL,0,0,NULL,NULL,NULL,NULL,0);
             INSERT INTO messages (session_id, role, content, timestamp) VALUES
               ('20260420_134942_1fd941','user','Fix the login bug',1776664183),
               ('20260420_134952_7ed74f','user','<context>',1776664193),
               ('20260420_134952_7ed74f','user','now add a test',1776664194),
               ('20260420_134952_7ed74f','assistant','done',1776664199);
             INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES
               ('20260623_050048_4ef4b9','assistant','',
                '[{\"id\":\"1\"}]',1782162050);",
        )
        .unwrap();
        drop(c);
        p
    }

    #[test]
    fn folds_compression_chains_into_one_run() {
        let tmp = tempfile::tempdir().unwrap();
        let db = make_db(tmp.path());
        let sessions = read_sessions(&db).unwrap();
        assert_eq!(sessions.len(), 3);
        let mut runs: Vec<_> = chains(&sessions)
            .into_iter()
            .map(|(leaf, anc)| (leaf.id.clone(), anc.len()))
            .collect();
        runs.sort();
        assert_eq!(
            runs,
            vec![
                ("20260420_134952_7ed74f".to_string(), 1),
                ("20260623_050048_4ef4b9".to_string(), 0)
            ]
        );
        let leaf = sessions
            .iter()
            .find(|s| s.id == "20260420_134952_7ed74f")
            .unwrap();
        assert_eq!(leaf.last_prompt.as_deref(), Some("now add a test"));
        assert_eq!(leaf.cost_usd, Some(0.03));
        assert!(!leaf.turn_open());
        let gw = sessions
            .iter()
            .find(|s| s.id == "20260623_050048_4ef4b9")
            .unwrap();
        assert!(gw.headless());
        assert!(gw.turn_open());
    }

    #[test]
    fn adapter_builds_records() {
        let tmp = tempfile::tempdir().unwrap();
        make_db(tmp.path());
        let procs = HashMap::new();
        let ctx = ScanCtx {
            procs: &procs,
            now: chrono::Utc::now(),
        };
        let mut a = HermesAdapter::new(tmp.path().to_path_buf(), "/home".into());
        let mut recs = a.scan(&ctx);
        recs.sort_by(|a, b| a.native_id.cmp(&b.native_id));
        assert_eq!(recs.len(), 2);
        let r = &recs[0];
        assert_eq!(r.title, "fix-login");
        assert_eq!(r.cwd, "/w/api");
        assert_eq!(r.started, from_secs_f64(1776664182.0));
        assert_eq!(r.tokens, Some(150));
        assert_eq!(recs[1].cwd, "/home");
        assert!(recs[1].headless);
    }
}
