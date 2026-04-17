use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
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

    // Spawn board directory file watcher (if configured)
    if let Some(dir) = board_dir {
        let watcher_store = Arc::clone(&store);
        tokio::spawn(watch::watch_board_dir(watcher_store, dir));
    }

    let router = gctrl_otel::create_router_dual(Arc::clone(&store), Arc::clone(&sqlite));
    let addr = format!("{host}:{port}");
    tracing::info!("gctrl OTel receiver listening on {addr}");
    tracing::info!("database: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
