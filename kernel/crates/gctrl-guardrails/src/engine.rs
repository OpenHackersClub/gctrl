use gctrl_core::{ExecutionContext, PolicyDecision};

pub trait GuardrailPolicy: Send + Sync {
    fn name(&self) -> &str;
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}

pub struct GuardrailEngine {
    policies: Vec<Box<dyn GuardrailPolicy>>,
}

impl GuardrailEngine {
    pub fn new() -> Self {
        Self {
            policies: Vec::new(),
        }
    }

    pub fn add_policy(&mut self, policy: Box<dyn GuardrailPolicy>) {
        self.policies.push(policy);
    }

    /// Evaluate all policies. Returns the first Deny or Warn, or Allow if all pass.
    pub fn evaluate(&self, context: &ExecutionContext) -> Vec<(String, PolicyDecision)> {
        self.policies
            .iter()
            .map(|p| (p.name().to_string(), p.check(context)))
            .collect()
    }

    /// Returns true if any policy denies the action.
    pub fn is_denied(&self, context: &ExecutionContext) -> bool {
        self.evaluate(context)
            .iter()
            .any(|(_, d)| matches!(d, PolicyDecision::Deny(_)))
    }
}

impl Default for GuardrailEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gctrl_core::SessionId;

    struct AlwaysAllow;
    impl GuardrailPolicy for AlwaysAllow {
        fn name(&self) -> &str { "always_allow" }
        fn check(&self, _ctx: &ExecutionContext) -> PolicyDecision {
            PolicyDecision::Allow
        }
    }

    struct AlwaysDeny;
    impl GuardrailPolicy for AlwaysDeny {
        fn name(&self) -> &str { "always_deny" }
        fn check(&self, _ctx: &ExecutionContext) -> PolicyDecision {
            PolicyDecision::Deny("blocked by policy".into())
        }
    }

    fn test_context() -> ExecutionContext {
        ExecutionContext {
            session_id: SessionId("test".into()),
            agent_name: "claude".into(),
            current_cost_usd: 0.0,
            span_count: 0,
            recent_operations: vec![],
            pending_command: None,
            pending_diff_lines: None,
        }
    }

    #[test]
    fn test_empty_engine_allows() {
        let engine = GuardrailEngine::new();
        let ctx = test_context();
        assert!(!engine.is_denied(&ctx));
        assert!(engine.evaluate(&ctx).is_empty());
    }

    #[test]
    fn test_allow_policy() {
        let mut engine = GuardrailEngine::new();
        engine.add_policy(Box::new(AlwaysAllow));
        let ctx = test_context();
        assert!(!engine.is_denied(&ctx));
    }

    #[test]
    fn test_deny_policy() {
        let mut engine = GuardrailEngine::new();
        engine.add_policy(Box::new(AlwaysDeny));
        let ctx = test_context();
        assert!(engine.is_denied(&ctx));
    }

    #[test]
    fn test_mixed_policies() {
        let mut engine = GuardrailEngine::new();
        engine.add_policy(Box::new(AlwaysAllow));
        engine.add_policy(Box::new(AlwaysDeny));
        let ctx = test_context();
        assert!(engine.is_denied(&ctx));
        let results = engine.evaluate(&ctx);
        assert_eq!(results.len(), 2);
    }
}
