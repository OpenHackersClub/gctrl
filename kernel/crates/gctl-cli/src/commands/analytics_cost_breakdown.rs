use anyhow::Result;
use gctl_storage::DuckDbStore;

pub fn run(session_id: &str, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;

    let session = store.get_session(&gctl_core::SessionId(session_id.into()))?
        .ok_or_else(|| anyhow::anyhow!("session not found: {}", session_id))?;

    let breakdown = store.get_session_cost_breakdown(session_id)?;

    println!("Session: {} ({})", session_id, session.agent_name);
    println!("Total cost: ${:.4}", session.total_cost_usd);
    println!();

    if breakdown.is_empty() {
        println!("No spans found.");
        return Ok(());
    }

    println!("{:<30} {:>10} {:>10} {:>10} {:>6}", "MODEL", "COST", "IN_TOKENS", "OUT_TOKENS", "SPANS");
    println!("{}", "-".repeat(70));
    for (model, cost, input, output, count) in &breakdown {
        println!("{:<30} {:>9.4} {:>10} {:>10} {:>6}", model, cost, input, output, count);
    }
    Ok(())
}
