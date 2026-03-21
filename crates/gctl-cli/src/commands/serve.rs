use anyhow::Result;
use gctl_storage::DuckDbStore;

pub async fn run(host: String, port: u16, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;

    let router = gctl_otel::create_router(store);
    let addr = format!("{host}:{port}");
    tracing::info!("gctl OTel receiver listening on {addr}");
    tracing::info!("database: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
