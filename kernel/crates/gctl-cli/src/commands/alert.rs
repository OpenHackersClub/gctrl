use anyhow::Result;
use gctl_core::AlertRule;
use gctl_storage::DuckDbStore;

pub fn create(
    name: &str,
    condition_type: &str,
    threshold: f64,
    action: &str,
    db_path: &str,
) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let rule = AlertRule {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        condition_type: condition_type.to_string(),
        threshold,
        action: action.to_string(),
        enabled: true,
    };
    store.insert_alert_rule(&rule)?;
    println!("Alert rule created: {} ({}>{} -> {})", name, condition_type, threshold, action);
    Ok(())
}

pub fn list(db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;
    let rules = store.list_alert_rules()?;

    if rules.is_empty() {
        println!("No alert rules configured.");
        return Ok(());
    }

    println!("{:<20} {:<18} {:>10} {:<8}", "NAME", "CONDITION", "THRESHOLD", "ACTION");
    println!("{}", "-".repeat(60));
    for rule in &rules {
        println!(
            "{:<20} {:<18} {:>10.2} {:<8}",
            rule.name, rule.condition_type, rule.threshold, rule.action
        );
    }
    Ok(())
}
