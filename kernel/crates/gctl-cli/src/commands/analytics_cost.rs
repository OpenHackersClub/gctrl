use anyhow::Result;
use gctl_storage::DuckDbStore;

pub fn run(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;

    let cost_by_model = store.get_cost_by_model()?;
    let cost_by_agent = store.get_cost_by_agent()?;

    println!("=== Cost by Model ===");
    if cost_by_model.is_empty() {
        println!("  No data.");
    } else {
        println!("{:<25} {:>10} {:>8}", "MODEL", "COST", "CALLS");
        println!("{}", "-".repeat(45));
        let total_cost: f64 = cost_by_model.iter().map(|(_, c, _)| c).sum();
        for (model, cost, calls) in &cost_by_model {
            let pct = if total_cost > 0.0 { cost / total_cost * 100.0 } else { 0.0 };
            println!("{:<25} {:>9.4} {:>8} ({:.0}%)", model, cost, calls, pct);
        }
        println!("{}", "-".repeat(45));
        println!("{:<25} {:>9.4}", "TOTAL", total_cost);
    }

    println!();
    println!("=== Cost by Agent ===");
    if cost_by_agent.is_empty() {
        println!("  No data.");
    } else {
        println!("{:<25} {:>10} {:>10}", "AGENT", "COST", "SESSIONS");
        println!("{}", "-".repeat(47));
        for (agent, cost, sessions) in &cost_by_agent {
            let avg = if *sessions > 0 { cost / *sessions as f64 } else { 0.0 };
            println!("{:<25} {:>9.4} {:>10} (avg ${:.4}/s)", agent, cost, sessions, avg);
        }
    }

    Ok(())
}
