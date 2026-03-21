use anyhow::Result;
use gctl_core::GctlConfig;
use gctl_storage::DuckDbStore;

pub async fn run(host: String, port: u16) -> Result<()> {
    let config = GctlConfig::default();
    let db_path = config.storage.db_path.to_string_lossy().to_string();
    let store = DuckDbStore::open(&db_path)?;

    let router = gctl_otel::create_router(store);
    let addr = format!("{host}:{port}");
    tracing::info!("gctl OTel receiver listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
