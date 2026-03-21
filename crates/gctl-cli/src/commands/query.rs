use anyhow::Result;
use gctl_core::GctlConfig;
use gctl_storage::DuckDbStore;
use gctl_query::QueryExecutor;

pub fn run(query: &str, raw: bool) -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(&config.storage.db_path.to_string_lossy())?;
    let executor = QueryExecutor::new(&store, raw, config.guardrails.max_query_rows);

    if raw {
        if !executor.is_raw_sql_allowed() {
            anyhow::bail!("Raw SQL is disabled. Set allow_raw_sql = true in config.");
        }
        // Raw SQL execution is a Phase 2 feature
        anyhow::bail!("Raw SQL execution not yet implemented. Use named queries: sessions, analytics");
    }

    let result = executor.run_named(query)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
