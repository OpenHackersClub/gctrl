use gctrl_core::{ExecutionContext, PolicyDecision};
use crate::engine::GuardrailPolicy;

/// Denies if session cost exceeds budget.
pub struct SessionBudgetPolicy {
    pub budget_usd: f64,
}

impl GuardrailPolicy for SessionBudgetPolicy {
    fn name(&self) -> &str {
        "session_budget"
    }

    fn check(&self, ctx: &ExecutionContext) -> PolicyDecision {
        if ctx.current_cost_usd > self.budget_usd {
            PolicyDecision::Deny(format!(
                "session cost ${:.2} exceeds budget ${:.2}",
                ctx.current_cost_usd, self.budget_usd
            ))
        } else if ctx.current_cost_usd > self.budget_usd * 0.8 {
            PolicyDecision::Warn(format!(
                "session cost ${:.2} is at {:.0}% of budget ${:.2}",
                ctx.current_cost_usd,
                (ctx.current_cost_usd / self.budget_usd) * 100.0,
                self.budget_usd
            ))
        } else {
            PolicyDecision::Allow
        }
    }
}

/// Detects repeated identical operations (possible infinite loop).
pub struct LoopDetectionPolicy {
    pub threshold: usize,
}

impl GuardrailPolicy for LoopDetectionPolicy {
    fn name(&self) -> &str {
        "loop_detection"
    }

    fn check(&self, ctx: &ExecutionContext) -> PolicyDecision {
        if ctx.recent_operations.len() < self.threshold {
            return PolicyDecision::Allow;
        }

        let last_n = &ctx.recent_operations[ctx.recent_operations.len() - self.threshold..];
        if last_n.iter().all(|op| op == &last_n[0]) {
            PolicyDecision::Deny(format!(
                "detected {} identical operations: '{}'",
                self.threshold, last_n[0]
            ))
        } else {
            PolicyDecision::Allow
        }
    }
}

/// Blocks specific commands.
pub struct CommandBlocklistPolicy {
    pub blocked: Vec<String>,
}

impl GuardrailPolicy for CommandBlocklistPolicy {
    fn name(&self) -> &str {
        "command_blocklist"
    }

    fn check(&self, ctx: &ExecutionContext) -> PolicyDecision {
        if let Some(ref cmd) = ctx.pending_command {
            for blocked in &self.blocked {
                if cmd.contains(blocked) {
                    return PolicyDecision::Deny(format!("command contains blocked pattern: '{blocked}'"));
                }
            }
        }
        PolicyDecision::Allow
    }
}

/// Warns or denies if diff exceeds line threshold.
pub struct DiffSizePolicy {
    pub warn_lines: u32,
    pub deny_lines: u32,
}

impl GuardrailPolicy for DiffSizePolicy {
    fn name(&self) -> &str {
        "diff_size"
    }

    fn check(&self, ctx: &ExecutionContext) -> PolicyDecision {
        if let Some(lines) = ctx.pending_diff_lines {
            if lines > self.deny_lines {
                PolicyDecision::Deny(format!("diff of {lines} lines exceeds max {}", self.deny_lines))
            } else if lines > self.warn_lines {
                PolicyDecision::Warn(format!("diff of {lines} lines exceeds warning threshold {}", self.warn_lines))
            } else {
                PolicyDecision::Allow
            }
        } else {
            PolicyDecision::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gctrl_core::SessionId;

    fn ctx_with_cost(cost: f64) -> ExecutionContext {
        ExecutionContext {
            session_id: SessionId("test".into()),
            agent_name: "claude".into(),
            current_cost_usd: cost,
            span_count: 0,
            recent_operations: vec![],
            pending_command: None,
            pending_diff_lines: None,
        }
    }

    #[test]
    fn test_budget_allow() {
        let policy = SessionBudgetPolicy { budget_usd: 10.0 };
        assert_eq!(policy.check(&ctx_with_cost(5.0)), PolicyDecision::Allow);
    }

    #[test]
    fn test_budget_warn() {
        let policy = SessionBudgetPolicy { budget_usd: 10.0 };
        let decision = policy.check(&ctx_with_cost(8.5));
        assert!(matches!(decision, PolicyDecision::Warn(_)));
    }

    #[test]
    fn test_budget_deny() {
        let policy = SessionBudgetPolicy { budget_usd: 10.0 };
        let decision = policy.check(&ctx_with_cost(11.0));
        assert!(matches!(decision, PolicyDecision::Deny(_)));
    }

    #[test]
    fn test_loop_detection_allow() {
        let policy = LoopDetectionPolicy { threshold: 3 };
        let mut ctx = ctx_with_cost(0.0);
        ctx.recent_operations = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(policy.check(&ctx), PolicyDecision::Allow);
    }

    #[test]
    fn test_loop_detection_deny() {
        let policy = LoopDetectionPolicy { threshold: 3 };
        let mut ctx = ctx_with_cost(0.0);
        ctx.recent_operations = vec!["bash".into(), "bash".into(), "bash".into()];
        assert!(matches!(policy.check(&ctx), PolicyDecision::Deny(_)));
    }

    #[test]
    fn test_command_blocklist() {
        let policy = CommandBlocklistPolicy {
            blocked: vec!["rm -rf /".into(), "git push --force".into()],
        };
        let mut ctx = ctx_with_cost(0.0);
        ctx.pending_command = Some("git push --force origin main".into());
        assert!(matches!(policy.check(&ctx), PolicyDecision::Deny(_)));

        ctx.pending_command = Some("git push origin main".into());
        assert_eq!(policy.check(&ctx), PolicyDecision::Allow);
    }

    #[test]
    fn test_diff_size_policy() {
        let policy = DiffSizePolicy {
            warn_lines: 500,
            deny_lines: 2000,
        };

        let mut ctx = ctx_with_cost(0.0);
        ctx.pending_diff_lines = Some(100);
        assert_eq!(policy.check(&ctx), PolicyDecision::Allow);

        ctx.pending_diff_lines = Some(800);
        assert!(matches!(policy.check(&ctx), PolicyDecision::Warn(_)));

        ctx.pending_diff_lines = Some(3000);
        assert!(matches!(policy.check(&ctx), PolicyDecision::Deny(_)));
    }
}
