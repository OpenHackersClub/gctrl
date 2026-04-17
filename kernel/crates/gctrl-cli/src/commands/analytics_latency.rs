use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let latencies = store.get_latency_by_model()?;

    println!("=== Latency by Model (ms) ===");
    if latencies.is_empty() {
        println!("  No data.");
    } else {
        println!("{:<25} {:>10} {:>10} {:>10}", "MODEL", "p50", "p95", "p99");
        println!("{}", "-".repeat(57));
        for (model, p50, p95, p99) in &latencies {
            println!("{:<25} {:>9.0}ms {:>9.0}ms {:>9.0}ms", model, p50, p95, p99);
        }
    }

    Ok(())
}
