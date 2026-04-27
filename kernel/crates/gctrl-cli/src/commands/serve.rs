use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use gctrl_core::{NetConfig, ProxyConfig, SchedulerConfig, SyncConfig};
use gctrl_scheduler::ScheduleRunner;
use gctrl_storage::{DuckDbStore, SqliteStore};

use super::watch;

pub async fn run(
    host: String,
    port: u16,
    db_path: &str,
    board_dir: Option<PathBuf>,
    proxy_enabled: bool,
) -> Result<()> {
    let store = Arc::new(DuckDbStore::open(db_path)?);

    // SQLite for board/inbox/persona — co-located with DuckDB
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    let sqlite = Arc::new(SqliteStore::open(&sqlite_path)?);
    tracing::info!("sqlite (board/inbox): {sqlite_path}");

    // Spawn board directory file watcher (if configured). Watcher writes to
    // SQLite (the source of truth for board data, and the origin side of
    // the SQLite → D1 sync).
    if let Some(dir) = board_dir {
        let watcher_store = Arc::clone(&sqlite);
        tokio::spawn(watch::watch_board_dir(watcher_store, dir));
    }

    let sync_config = SyncConfig::from_env();
    let sync_config = if sync_config.d1_enabled() {
        tracing::info!("D1 sync enabled: database_id={}", sync_config.d1_database_id);
        Some(Arc::new(sync_config))
    } else {
        None
    };

    let net_config = NetConfig::from_env();
    if net_config.brave_api_key.is_some() {
        tracing::info!("Brave Search enabled");
    }
    if net_config.cf_browser_enabled() {
        tracing::info!("Cloudflare Browser Rendering enabled");
    }

    // Spawn the scheduler runner. Uses defaults from `SchedulerConfig::default()`
    // (30s poll, 16 jobs/tick, 60s timeout) — operators can override later via
    // config file once we wire `~/.config/gctrl/config.toml` parsing.
    let scheduler_config = SchedulerConfig::default();
    if scheduler_config.enabled {
        let runner_store = Arc::clone(&sqlite);
        let runner_cfg = scheduler_config.clone();
        tokio::spawn(async move {
            ScheduleRunner::new(runner_store, runner_cfg).run_forever().await;
        });
        tracing::info!("scheduler runner spawned (poll={}s)", scheduler_config.poll_interval_secs);
    }

    let router = gctrl_otel::create_router_full(
        Arc::clone(&store),
        Arc::clone(&sqlite),
        sync_config,
        Arc::new(net_config),
    );
    let addr = format!("{host}:{port}");
    tracing::info!("gctrl OTel receiver listening on {addr}");
    tracing::info!("database: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let axum_fut = axum::serve(listener, router);

    // Spawn the MITM proxy alongside the receiver if enabled. Both share the
    // same DuckDbStore so traffic rows go through the kernel's single-writer
    // lock — no parallel data path.
    if proxy_enabled {
        let mut proxy_config = ProxyConfig::default();
        if let Ok(p) = std::env::var("GCTRL_PROXY_PORT") {
            if let Ok(p) = p.parse::<u16>() {
                proxy_config.listen_port = p;
            }
        }
        let proxy_store = Arc::clone(&store);
        let proxy_cfg = proxy_config.clone();
        tokio::spawn(async move {
            if let Err(e) = gctrl_proxy::run(proxy_store, proxy_cfg).await {
                tracing::error!(error = %e, "proxy exited with error");
            }
        });
        tracing::info!(
            "MITM proxy enabled on {}:{}",
            proxy_config.listen_host,
            proxy_config.listen_port
        );
    }

    axum_fut.await?;
    Ok(())
}
