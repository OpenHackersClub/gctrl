use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use gctrl_core::{NetConfig, SyncConfig};
use gctrl_storage::{DuckDbStore, SqliteStore};

use super::watch;

pub async fn run(host: String, port: u16, db_path: &str, board_dir: Option<PathBuf>) -> Result<()> {
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
    axum::serve(listener, router).await?;
    Ok(())
}
