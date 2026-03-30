use anyhow::Result;
use gctl_core::Tag;
use gctl_storage::DuckDbStore;

pub fn run(
    target_type: &str,
    target_id: &str,
    key: &str,
    value: &str,
    db_path: &str,
) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let tag = Tag {
        id,
        target_type: target_type.to_string(),
        target_id: target_id.to_string(),
        key: key.to_string(),
        value: value.to_string(),
    };
    store.insert_tag(&tag)?;
    println!("Tag created: {}={} on {} {}", key, value, target_type, target_id);
    Ok(())
}
