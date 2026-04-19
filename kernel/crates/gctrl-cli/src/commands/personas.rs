use std::path::Path;

use anyhow::Result;
use gctrl_storage::{import_persona_dir, SqliteStore};

pub fn import(dir: &Path, db_path: &str) -> Result<()> {
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    let store = SqliteStore::open(&sqlite_path)?;

    let imported = import_persona_dir(dir)?;

    let mut created = 0;
    let mut updated = 0;
    for p in &imported.personas {
        if store.upsert_persona(p)? {
            created += 1;
        } else {
            updated += 1;
        }
    }

    let mut rule_created = 0;
    let mut rule_updated = 0;
    for r in &imported.review_rules {
        if store.upsert_review_rule(r)? {
            rule_created += 1;
        } else {
            rule_updated += 1;
        }
    }

    println!(
        "personas: {} created, {} updated ({} total)",
        created,
        updated,
        imported.personas.len()
    );
    println!(
        "review rules: {} created, {} updated ({} total)",
        rule_created,
        rule_updated,
        imported.review_rules.len()
    );
    println!("sqlite: {sqlite_path}");
    Ok(())
}

pub fn list(db_path: &str) -> Result<()> {
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    let store = SqliteStore::open(&sqlite_path)?;

    let personas = store.list_personas()?;
    let rules = store.list_review_rules()?;

    println!("Personas ({}):", personas.len());
    for p in &personas {
        println!("  {:12} {}", p.id, p.name);
    }
    println!();
    println!("Review rules ({}):", rules.len());
    for r in &rules {
        println!("  {:30} → {:?}", r.pr_type, r.persona_ids);
    }
    Ok(())
}
