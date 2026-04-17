use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(limit: usize, format: &str, agent: Option<&str>, status: Option<&str>, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let sessions = store.list_sessions_filtered(limit, agent, status)?;

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
