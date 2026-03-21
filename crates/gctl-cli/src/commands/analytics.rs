use anyhow::Result;
use gctl_core::GctlConfig;
use gctl_storage::DuckDbStore;

pub fn run() -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(&config.storage.db_path.to_string_lossy())?;
    let analytics = store.get_analytics()?;

    println!("=== GroundCtrl Analytics ===");
    println!("Sessions:      {}", analytics.total_sessions);
    println!("Spans:         {}", analytics.total_spans);
    println!("Total cost:    ${:.4}", analytics.total_cost_usd);
    println!("Input tokens:  {}", analytics.total_input_tokens);
    println!("Output tokens: {}", analytics.total_output_tokens);

    if !analytics.by_agent.is_empty() {
        println!("\n--- By Agent ---");
        for a in &analytics.by_agent {
            println!("  {}: {} sessions, ${:.4}", a.agent_name, a.session_count, a.total_cost_usd);
        }
    }

    if !analytics.by_model.is_empty() {
        println!("\n--- By Model ---");
        for m in &analytics.by_model {
            println!("  {}: {} spans, ${:.4}", m.model, m.span_count, m.total_cost_usd);
        }
    }

    Ok(())
}
