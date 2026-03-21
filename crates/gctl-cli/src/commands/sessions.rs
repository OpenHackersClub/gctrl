use anyhow::Result;
use gctl_core::GctlConfig;
use gctl_storage::DuckDbStore;

pub fn run(limit: usize, format: &str) -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(&config.storage.db_path.to_string_lossy())?;
    let sessions = store.list_sessions(limit)?;

    match format {
        "json" => {
            println!("{}", serde_json::to_string_pretty(&sessions)?);
        }
        _ => {
            if sessions.is_empty() {
                println!("No sessions found.");
                return Ok(());
            }
            println!(
                "{:<36} {:<20} {:<10} {:>10} {:>10}",
                "ID", "AGENT", "STATUS", "COST", "TOKENS"
            );
            println!("{}", "-".repeat(90));
            for s in &sessions {
                println!(
                    "{:<36} {:<20} {:<10} {:>9.4} {:>10}",
                    s.id.0,
                    s.agent_name,
                    s.status.as_str(),
                    s.total_cost_usd,
                    s.total_input_tokens + s.total_output_tokens
                );
            }
        }
    }
    Ok(())
}
