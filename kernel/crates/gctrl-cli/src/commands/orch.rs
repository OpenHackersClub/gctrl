use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use gctrl_orch::{OrchConfig, Worker};
use gctrl_storage::SqliteStore;

#[allow(clippy::too_many_arguments)]
pub async fn run(
    db_path: &str,
    once: bool,
    interval_secs: u64,
    max_concurrent: usize,
    timeout_secs: u64,
    agent: Vec<String>,
    working_dir: Option<PathBuf>,
    dry_run: bool,
) -> Result<()> {
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    let store = Arc::new(SqliteStore::open(&sqlite_path)?);

    let config = OrchConfig {
        agent_cmd: agent,
        working_dir: working_dir
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from(".")),
        poll_interval: Duration::from_secs(interval_secs),
        max_concurrent,
        task_timeout: Duration::from_secs(timeout_secs),
        dry_run,
    };

    tracing::info!(
        sqlite = %sqlite_path,
        agent = ?config.agent_cmd,
        interval_s = interval_secs,
        max_concurrent,
        timeout_s = timeout_secs,
        dry_run,
        "orch: starting"
    );

    let worker = Worker::new(store, config);
    if once {
        let outcomes = worker.run_once().await?;
        println!("dispatched {} task(s)", outcomes.len());
        for o in outcomes {
            println!("  {o:?}");
        }
        Ok(())
    } else {
        worker.run_forever().await
    }
}
