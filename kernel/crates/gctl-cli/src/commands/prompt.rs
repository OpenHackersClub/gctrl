use anyhow::Result;
use gctl_core::PromptVersion;
use gctl_storage::DuckDbStore;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn register(db_path: &str, file_path: &str, label: Option<&str>) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let content = std::fs::read_to_string(file_path)?;

    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());

    // Rough token count: ~4 chars per token
    let token_count = (content.len() / 4) as i32;

    let pv = PromptVersion {
        hash: hash.clone(),
        content,
        file_path: Some(file_path.to_string()),
        label: label.map(String::from),
        created_at: chrono::Utc::now(),
        token_count: Some(token_count),
    };
    store.insert_prompt_version(&pv)?;
    println!("Registered prompt: hash={} tokens={} file={}", hash, token_count, file_path);
    Ok(())
}

pub fn list(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let versions = store.list_prompt_versions()?;

    if versions.is_empty() {
        println!("No prompt versions registered.");
        return Ok(());
    }

    println!("{:<18} {:<10} {:<8} {:<30} {}", "HASH", "LABEL", "TOKENS", "FILE", "CREATED");
    println!("{}", "-".repeat(90));
    for pv in &versions {
        println!(
            "{:<18} {:<10} {:<8} {:<30} {}",
            &pv.hash[..pv.hash.len().min(16)],
            pv.label.as_deref().unwrap_or("-"),
            pv.token_count.unwrap_or(0),
            pv.file_path.as_deref().unwrap_or("-"),
            pv.created_at.format("%Y-%m-%d %H:%M")
        );
    }
    Ok(())
}
