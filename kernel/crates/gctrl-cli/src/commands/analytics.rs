use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let analytics = store.get_analytics()?;
    let cost_by_model = store.get_cost_by_model().unwrap_or_default();
    let cost_by_agent = store.get_cost_by_agent().unwrap_or_default();
    let latencies = store.get_latency_by_model().unwrap_or_default();

    println!("=== GroundCtrl Analytics ===\n");
    println!("Sessions:      {}", analytics.total_sessions);
    println!("Spans:         {}", analytics.total_spans);
    println!("Total cost:    ${:.4}", analytics.total_cost_usd);
    println!("Input tokens:  {}", analytics.total_input_tokens);
    println!("Output tokens: {}", analytics.total_output_tokens);

    if !cost_by_model.is_empty() {
        println!("\n--- Cost by Model ---");
        for (model, cost, calls) in &cost_by_model {
            println!("  {:<25} ${:.4}  ({} calls)", model, cost, calls);
        }
    }

    if !cost_by_agent.is_empty() {
        println!("\n--- Cost by Agent ---");
        for (agent, cost, sessions) in &cost_by_agent {
            println!("  {:<25} ${:.4}  ({} sessions)", agent, cost, sessions);
        }
    }

    if !latencies.is_empty() {
        println!("\n--- Latency by Model (ms) ---");
        println!("  {:<25} {:>8} {:>8} {:>8}", "MODEL", "p50", "p95", "p99");
        for (model, p50, p95, p99) in &latencies {
            println!("  {:<25} {:>7.0}  {:>7.0}  {:>7.0}", model, p50, p95, p99);
        }
    }

    Ok(())
}
