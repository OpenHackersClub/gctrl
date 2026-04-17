use anyhow::Result;
use gctrl_core::GctlConfig;
use gctrl_storage::DuckDbStore;
use gctrl_query::QueryExecutor;

pub fn run(query: &str, raw: bool, db_path: &str) -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(db_path)?;
    let executor = QueryExecutor::new(&store, raw, config.guardrails.max_query_rows);

    if raw {
        if !executor.is_raw_sql_allowed() {
            anyhow::bail!("Raw SQL is disabled. Set allow_raw_sql = true in config.");
        }
        anyhow::bail!("Raw SQL execution not yet implemented. Use named queries: sessions, analytics");
    }

    let result = executor.run_named(query)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
