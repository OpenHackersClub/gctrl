use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(days: u32, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let aggs = store.get_daily_aggregates(days)?;

    if aggs.is_empty() {
        println!("No daily aggregates found.");
        return Ok(());
    }

    println!("=== Daily Aggregates (last {} days) ===", days);
    println!("{:<12} {:<15} {:<15} {:>10}", "DATE", "METRIC", "DIMENSION", "VALUE");
    println!("{}", "-".repeat(55));
    for agg in &aggs {
        println!("{:<12} {:<15} {:<15} {:>10.4}", agg.date, agg.metric, agg.dimension, agg.value);
    }

    Ok(())
}
