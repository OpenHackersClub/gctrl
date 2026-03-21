use anyhow::Result;
use gctl_core::Score;
use gctl_storage::DuckDbStore;

pub fn run(
    target_type: &str,
    target_id: &str,
    name: &str,
    value: f64,
    comment: Option<&str>,
    source: &str,
    db_path: &str,
) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let score = Score {
        id: id.clone(),
        target_type: target_type.to_string(),
        target_id: target_id.to_string(),
        name: name.to_string(),
        value,
        comment: comment.map(String::from),
        source: source.to_string(),
        scored_by: None,
        created_at: chrono::Utc::now(),
    };
    store.insert_score(&score)?;
    println!("Score created: {} = {} on {} {}", name, value, target_type, target_id);
    Ok(())
}
