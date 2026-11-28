//! The harness adapter contract. Each harness reads its own store and
//! process table rows into [`RunRecord`]s; the index turns records into
//! [`crate::model::AgentRun`]s. Adding a harness means adding one adapter
//! and one [`Harness`] variant with its resume command.

use crate::model::{Harness, LiveInfo, PrLink};
use crate::procs::Proc;
use chrono::{DateTime, TimeZone, Utc};
use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

/// One run as a harness reports it, before project resolution.
#[derive(Debug, Clone)]
pub struct RunRecord {
    pub harness: Harness,
    pub native_id: String,
    /// Stable conversation identity; the root session for compression chains.
    pub identity: String,
    pub title: String,
    pub name: Option<String>,
    pub cwd: String,
    /// Git origin URL the harness recorded, when it records one.
    pub origin: Option<String>,
    pub git_branch: Option<String>,
    pub last_prompt: Option<String>,
    pub pr: Option<PrLink>,
    pub cost_usd: Option<f64>,
    pub tokens: Option<i64>,
    pub model: Option<String>,
    pub started: DateTime<Utc>,
    pub updated: DateTime<Utc>,
    pub headless: bool,
    pub archived: bool,
    pub live: Option<LiveInfo>,
}

impl RunRecord {
    /// A record with every optional field empty.
    pub fn new(harness: Harness, native_id: String, cwd: String, at: DateTime<Utc>) -> Self {
        Self {
            harness,
            identity: native_id.clone(),
            native_id,
            title: "(untitled)".into(),
            name: None,
            cwd,
            origin: None,
            git_branch: None,
            last_prompt: None,
            pr: None,
            cost_usd: None,
            tokens: None,
            model: None,
            started: at,
            updated: at,
            headless: false,
            archived: false,
            live: None,
        }
    }
}

/// Inputs shared by every adapter in one refresh.
pub struct ScanCtx<'a> {
    pub procs: &'a HashMap<u32, Proc>,
    pub now: DateTime<Utc>,
}

impl ScanCtx<'_> {
    /// Whether a run last active at `updated` needs detail reads (prompts,
    /// turn state): it is live or inside the default view.
    pub fn wants_detail(&self, live: bool, updated: DateTime<Utc>) -> bool {
        live || self.now - updated < crate::index::stale_after()
    }
}

pub trait Adapter: Send {
    fn harness(&self) -> Harness;
    fn scan(&mut self, ctx: &ScanCtx<'_>) -> Vec<RunRecord>;
}

/// A run a harness process can belong to. `alias` is an id the process may
/// carry in argv for this run (an earlier id in a chain); `run` is the id
/// the process is attributed to.
#[derive(Debug, Clone)]
pub struct Candidate<'a> {
    pub alias: &'a str,
    pub run: &'a str,
    pub cwd: &'a str,
    pub updated_ms: i64,
    pub interactive: bool,
}

/// Attribute harness processes to runs, for harnesses without a live
/// registry. One process per tty counts (the lowest pid, which is the parent
/// of any helper it spawned). A process whose argv contains a run id belongs
/// to that run; otherwise it belongs to the most recently updated unclaimed
/// interactive run in its working directory. `cwds` resolves the working
/// directory of the pids left over after the argv pass.
pub fn match_processes(
    cands: &[Candidate<'_>],
    procs: &HashMap<u32, Proc>,
    is_harness: impl Fn(&Proc) -> bool,
    cwds: impl FnOnce(&[u32]) -> HashMap<u32, String>,
) -> HashMap<String, u32> {
    let mut by_tty: HashMap<&str, &Proc> = HashMap::new();
    for p in procs.values().filter(|p| is_harness(p)) {
        let Some(tty) = p.tty.as_deref() else {
            continue;
        };
        match by_tty.get(tty) {
            Some(cur) if cur.pid < p.pid => {}
            _ => {
                by_tty.insert(tty, p);
            }
        }
    }
    let mut claimed: HashMap<String, u32> = HashMap::new();
    let mut pending: Vec<&Proc> = Vec::new();
    for p in by_tty.values() {
        let command = p.command.to_ascii_lowercase();
        let hit = cands
            .iter()
            .filter(|c| !c.alias.is_empty() && command.contains(&c.alias.to_ascii_lowercase()))
            .max_by_key(|c| c.alias.len());
        match hit {
            Some(c) => {
                claimed.insert(c.run.to_string(), p.pid);
            }
            None => pending.push(p),
        }
    }
    if pending.is_empty() {
        return claimed;
    }
    let pids: Vec<u32> = pending.iter().map(|p| p.pid).collect();
    let dirs = cwds(&pids);
    let mut taken: HashSet<String> = claimed.keys().cloned().collect();
    for p in pending {
        let Some(cwd) = dirs.get(&p.pid) else {
            continue;
        };
        let newest = cands
            .iter()
            .filter(|c| c.cwd == cwd && c.interactive && !taken.contains(c.run))
            .max_by_key(|c| c.updated_ms);
        if let Some(c) = newest {
            taken.insert(c.run.to_string());
            claimed.insert(c.run.to_string(), p.pid);
        }
    }
    claimed
}

pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

pub fn from_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default()
}

pub fn from_secs_f64(s: f64) -> DateTime<Utc> {
    from_ms((s * 1000.0) as i64)
}

pub fn from_system(t: SystemTime) -> DateTime<Utc> {
    DateTime::<Utc>::from(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, tty: Option<&str>, command: &str) -> Proc {
        Proc {
            pid,
            lstart: "x".into(),
            tty: tty.map(str::to_string),
            command: command.into(),
        }
    }

    fn cand<'a>(id: &'a str, cwd: &'a str, updated_ms: i64, interactive: bool) -> Candidate<'a> {
        Candidate {
            alias: id,
            run: id,
            cwd,
            updated_ms,
            interactive,
        }
    }

    #[test]
    fn matches_by_argv_then_cwd_one_process_per_tty() {
        let cands = vec![
            cand("20260420_134853_5501ee", "/w/api", 100, true),
            cand("20260420_134942_1fd941", "/w/web", 50, true),
            cand("20260420_134950_951b5f", "/w/web", 90, true),
            cand("20260420_134999_aaaaaa", "/w/web", 99, false),
            // An earlier id in a chain resolves to its newest run.
            Candidate {
                alias: "20260101_000000_000001",
                run: "20260420_134853_5501ee",
                cwd: "/w/api",
                updated_ms: 1,
                interactive: true,
            },
        ];
        let procs: HashMap<u32, Proc> = [
            proc(
                100,
                Some("/dev/ttys001"),
                "python3 /v/bin/hermes --resume 20260101_000000_000001",
            ),
            proc(200, Some("/dev/ttys002"), "python3 /v/bin/hermes --tui"),
            proc(201, Some("/dev/ttys002"), "python3 /v/bin/hermes worker"),
            proc(300, None, "python3 /v/bin/hermes gateway"),
        ]
        .into_iter()
        .map(|p| (p.pid, p))
        .collect();
        let live = match_processes(
            &cands,
            &procs,
            |p| p.command.contains("/hermes"),
            |pids| {
                assert_eq!(pids, &[200]);
                [(200, "/w/web".to_string())].into_iter().collect()
            },
        );
        assert_eq!(live.get("20260420_134853_5501ee"), Some(&100));
        assert_eq!(live.get("20260420_134950_951b5f"), Some(&200));
        assert_eq!(live.len(), 2);
    }
}
