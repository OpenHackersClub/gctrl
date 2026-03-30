use anyhow::Result;
use gctl_core::{ExecutionContext, GctlConfig, SessionId};
use gctl_guardrails::GuardrailEngine;
use gctl_guardrails::policies::{
    CommandBlocklistPolicy, LoopDetectionPolicy, SessionBudgetPolicy,
};
use gctl_storage::DuckDbStore;

pub fn run(session_id: &str, db_path: &str) -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(db_path)?;

    let session = store.get_session(&SessionId(session_id.into()))?;
    let session = match session {
        Some(s) => s,
        None => {
            println!("Session {session_id} not found.");
            return Ok(());
        }
    };

    let mut engine = GuardrailEngine::new();

    if let Some(budget) = config.guardrails.session_budget_usd {
        engine.add_policy(Box::new(SessionBudgetPolicy { budget_usd: budget }));
    }
    engine.add_policy(Box::new(LoopDetectionPolicy {
        threshold: config.guardrails.loop_detection_threshold as usize,
    }));
    engine.add_policy(Box::new(CommandBlocklistPolicy {
        blocked: config.guardrails.blocked_commands.clone(),
    }));

    let ctx = ExecutionContext {
        session_id: session.id.clone(),
        agent_name: session.agent_name.clone(),
        current_cost_usd: session.total_cost_usd,
        span_count: 0,
        recent_operations: vec![],
        pending_command: None,
        pending_diff_lines: None,
    };

    let results = engine.evaluate(&ctx);
    if results.is_empty() {
        println!("No guardrail policies configured.");
        return Ok(());
    }

    for (name, decision) in &results {
        let icon = match decision {
            gctl_core::PolicyDecision::Allow => "PASS",
            gctl_core::PolicyDecision::Warn(_) => "WARN",
            gctl_core::PolicyDecision::Deny(_) => "DENY",
        };
        println!("[{icon}] {name}: {decision:?}");
    }
    Ok(())
}
