use anyhow::Result;
use gctrl_storage::DuckDbStore;

pub fn run(session_id: &str, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let scores = store.auto_score_session(session_id)?;

    if scores.is_empty() {
        println!("No scores generated for session {session_id}.");
        return Ok(());
    }

    println!("Auto-scored session {}:", session_id);
    for score in &scores {
        println!("  {:<25} {:.2}", score.name, score.value);
    }
    Ok(())
}
