//! `gctrld scheduler ...` — admin/debug commands against the schedules table.
//!
//! These open the SQLite store directly (same pattern as `board`, `personas`,
//! `prompt`). The runner fiber lives in the long-running `gctrld serve` process;
//! these commands manipulate rows that the runner picks up on its next tick.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::Utc;
use gctrl_core::{Schedule, ScheduleFilter};
use gctrl_scheduler::cron::next_after;
use gctrl_storage::SqliteStore;

fn open_store(db_path: &str) -> Result<Arc<SqliteStore>> {
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    Ok(Arc::new(SqliteStore::open(&sqlite_path)?))
}

pub fn list(db_path: &str, enabled_only: bool, format: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let filter = ScheduleFilter {
        enabled: if enabled_only { Some(true) } else { None },
        ..Default::default()
    };
    let rows = store.list_schedules(&filter)?;
    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&rows)?),
        _ => print_table(&rows),
    }
    Ok(())
}

pub fn show(db_path: &str, id_or_name: &str) -> Result<()> {
    let store = open_store(db_path)?;
    match store.get_schedule(id_or_name)? {
        Some(s) => println!("{}", serde_json::to_string_pretty(&s)?),
        None => return Err(anyhow!("no schedule named or with id '{id_or_name}'")),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn add(
    db_path: &str,
    name: &str,
    cron: &str,
    target_url: &str,
    method: &str,
    body: Option<&str>,
    timeout_secs: i64,
) -> Result<()> {
    let store = open_store(db_path)?;
    // Validate cron up-front. A bad expression here means the schedule would
    // never compute next_run_at; better to fail loudly at create time.
    let next = next_after(cron, Utc::now())
        .map_err(|e| anyhow!("invalid cron '{cron}': {e}"))?
        .map(|dt| dt.to_rfc3339());

    let body_json = body
        .map(|b| serde_json::from_str::<serde_json::Value>(b))
        .transpose()
        .map_err(|e| anyhow!("--body must be valid JSON: {e}"))?;

    let now = Utc::now().to_rfc3339();
    let sched = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        cron: cron.to_string(),
        target_kind: gctrl_core::TARGET_KIND_HTTP.into(),
        target_url: target_url.to_string(),
        target_method: method.to_uppercase(),
        body_json,
        headers_json: None,
        command: None,
        cwd: None,
        env_keys: None,
        timeout_secs,
        enabled: true,
        next_run_at: next,
        last_run_at: None,
        last_status: None,
        last_response: None,
        last_error: None,
        run_count: 0,
        failure_count: 0,
        created_at: now.clone(),
        updated_at: now,
        health: None,
    };
    store.create_schedule(&sched)?;
    println!("created schedule '{}' (id={})", sched.name, sched.id);
    if let Some(n) = sched.next_run_at {
        println!("  next_run_at: {n}");
    }
    Ok(())
}

pub fn rm(db_path: &str, id_or_name: &str) -> Result<()> {
    let store = open_store(db_path)?;
    if store.delete_schedule(id_or_name)? {
        println!("deleted schedule '{id_or_name}'");
        Ok(())
    } else {
        Err(anyhow!("no schedule named or with id '{id_or_name}'"))
    }
}

pub fn enable(db_path: &str, id_or_name: &str, enabled: bool) -> Result<()> {
    let store = open_store(db_path)?;
    if !store.set_schedule_enabled(id_or_name, enabled)? {
        return Err(anyhow!("no schedule named or with id '{id_or_name}'"));
    }
    if enabled {
        if let Some(s) = store.get_schedule(id_or_name)? {
            let next = next_after(&s.cron, Utc::now())
                .ok()
                .flatten()
                .map(|dt| dt.to_rfc3339());
            store.set_schedule_next_run(&s.id, next.as_deref())?;
        }
    }
    println!(
        "{} schedule '{id_or_name}'",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// Fire a schedule immediately via the daemon's HTTP API. Requires the daemon
/// to be running — we don't replicate the dispatch logic here because that
/// would split ownership of run_count / last_status across two code paths.
pub async fn run_now(db_path: &str, id_or_name: &str, daemon_url: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let sched = store
        .get_schedule(id_or_name)?
        .ok_or_else(|| anyhow!("no schedule named or with id '{id_or_name}'"))?;
    let url = format!("{}/api/schedules/{}/run", daemon_url.trim_end_matches('/'), sched.id);
    let resp = reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .map_err(|e| anyhow!("contacting daemon at {daemon_url}: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("daemon returned {status}: {body}"));
    }
    println!("{body}");
    Ok(())
}

fn print_table(rows: &[Schedule]) {
    if rows.is_empty() {
        println!("(no schedules)");
        return;
    }
    println!(
        "{:<24} {:<20} {:<8} {:<26} {}",
        "name", "cron", "enabled", "next_run_at", "target_url"
    );
    println!("{}", "─".repeat(120));
    for s in rows {
        println!(
            "{:<24} {:<20} {:<8} {:<26} {}",
            truncate_col(&s.name, 24),
            truncate_col(&s.cron, 20),
            s.enabled,
            s.next_run_at.as_deref().unwrap_or("-"),
            s.target_url
        );
    }
}

fn truncate_col(s: &str, w: usize) -> String {
    if s.len() <= w {
        s.to_string()
    } else {
        format!("{}…", &s[..w.saturating_sub(1)])
    }
}
