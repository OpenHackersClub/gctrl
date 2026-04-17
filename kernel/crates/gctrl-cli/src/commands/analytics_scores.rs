use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(name: &str, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let (pass, fail, avg) = store.get_score_summary(name)?;
    let total = pass + fail;
    let rate = if total > 0 { pass as f64 / total as f64 * 100.0 } else { 0.0 };

    println!("=== Score Summary: {} ===", name);
    println!("Total:     {}", total);
    println!("Pass:      {} ({:.1}%)", pass, rate);
    println!("Fail:      {}", fail);
    println!("Avg value: {:.2}", avg);

    Ok(())
}
