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
    max_per_pass: usize,
    timeout_secs: u64,
    agent: Vec<String>,
    working_dir: Option<PathBuf>,
    env_passthrough: Vec<String>,
    dry_run: bool,
) -> Result<()> {
    // Flag wins; otherwise take the LaunchAgent-friendly env form. Same shape
    // as GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS.
    let env_passthrough = if env_passthrough.is_empty() {
        std::env::var("GCTRL_ORCH_ENV_PASSTHROUGH")
            .map(|s| {
                s.split(',')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        env_passthrough
    };

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
        env_passthrough,
        poll_interval: Duration::from_secs(interval_secs),
        max_per_pass,
        task_timeout: Duration::from_secs(timeout_secs),
        dry_run,
        kernel_base_url: std::env::var("GCTL_KERNEL_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:4318".to_string()),
    };

    tracing::info!(
        sqlite = %sqlite_path,
        agent = ?config.agent_cmd,
        interval_s = interval_secs,
        max_per_pass,
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
