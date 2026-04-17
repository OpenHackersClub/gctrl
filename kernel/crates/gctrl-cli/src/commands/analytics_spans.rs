use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let dist = store.get_span_type_distribution()?;

    if dist.is_empty() {
        println!("No spans found.");
        return Ok(());
    }

    println!("{:<15} {:>8} {:>8}", "TYPE", "COUNT", "PCT");
    println!("{}", "-".repeat(33));
    for (span_type, count, pct) in &dist {
        println!("{:<15} {:>8} {:>7.1}%", span_type, count, pct);
    }
    Ok(())
}
