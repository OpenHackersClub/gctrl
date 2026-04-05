use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use gctl_storage::DuckDbStore;

use super::watch;

pub async fn run(host: String, port: u16, db_path: &str, board_dir: Option<PathBuf>) -> Result<()> {
    let store = Arc::new(DuckDbStore::open(db_path)?);

    // Spawn board directory file watcher (if configured)
    if let Some(dir) = board_dir {
        let watcher_store = Arc::clone(&store);
        tokio::spawn(watch::watch_board_dir(watcher_store, dir));
    }

    let router = gctl_otel::create_router_from_arc(Arc::clone(&store));
    let addr = format!("{host}:{port}");
    tracing::info!("gctl OTel receiver listening on {addr}");
    tracing::info!("database: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
