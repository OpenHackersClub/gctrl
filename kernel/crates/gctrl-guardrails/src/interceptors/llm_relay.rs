use std::sync::Arc;

use async_trait::async_trait;
use gctrl_core::{ActiveCapabilities, TaintLevel};

use crate::interception::{InterceptionResult, ToolInterceptor, ToolInvocation};
use crate::taint::TaintTracker;

pub struct LlmRelayInterceptor {
    taint_tracker: Arc<TaintTracker>,
    known_secrets: Vec<(String, gctrl_core::TaintLabel)>,
}

impl LlmRelayInterceptor {
    pub fn new(taint_tracker: Arc<TaintTracker>) -> Self {
        Self {
            taint_tracker,
            known_secrets: Vec::new(),
        }
    }

    pub fn register_secret(&mut self, plaintext: String, label: gctrl_core::TaintLabel) {
        self.taint_tracker.register(&plaintext, label.clone());
        self.known_secrets.push((plaintext, label));
    }
}

#[async_trait]
impl ToolInterceptor for LlmRelayInterceptor {
    fn name(&self) -> &str {
        "llm_relay_classified"
    }

    async fn intercept(
        &self,
        invocation: &ToolInvocation,
        _caps: &ActiveCapabilities,
    ) -> InterceptionResult {
        if !matches!(
            invocation.tool_name.as_str(),
            "llm_relay" | "chat" | "complete"
        ) {
            return InterceptionResult::Proceed;
        }

        let body = invocation.parameters.to_string();

        let secrets_refs: Vec<(&str, &gctrl_core::TaintLabel)> = self
            .known_secrets
            .iter()
            .map(|(s, l)| (s.as_str(), l))
            .collect();

        let found = self
            .taint_tracker
            .scan_for_plaintext(&body, &secrets_refs);

        let max_taint = found.iter().map(|l| l.level).max();

        match max_taint {
            Some(TaintLevel::Secret) => InterceptionResult::Deny(
                "classified data (Secret level) detected in LLM relay request — blocked".into(),
            ),
            Some(TaintLevel::Confidential) => InterceptionResult::Deny(
                "classified data (Confidential level) detected in LLM relay request — blocked"
                    .into(),
            ),
            Some(TaintLevel::Internal) => InterceptionResult::Escalate(
                "classified data (Internal level) detected — requires trusted/local LLM".into(),
            ),
            _ => InterceptionResult::Proceed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gctrl_core::{SessionId, TaintLabel};

    fn make_invocation(body: &str) -> ToolInvocation {
        ToolInvocation {
            tool_name: "llm_relay".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::json!({ "prompt": body }),
            affected_paths: vec![],
            affected_hosts: vec![],
            affected_commands: vec![],
        }
    }

    #[tokio::test]
    async fn blocks_secret_data_in_prompt() {
        let tracker = Arc::new(TaintTracker::new());
        let mut interceptor = LlmRelayInterceptor::new(tracker);
        interceptor.register_secret(
            "sk-ant-super-secret".into(),
            TaintLabel {
                source: "env.API_KEY".into(),
                level: TaintLevel::Secret,
            },
        );

        let inv = make_invocation("Please use sk-ant-super-secret to call the API");
        let caps = ActiveCapabilities::empty();
        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_denied());
    }

    #[tokio::test]
    async fn allows_clean_prompt() {
        let tracker = Arc::new(TaintTracker::new());
        let mut interceptor = LlmRelayInterceptor::new(tracker);
        interceptor.register_secret(
            "sk-ant-super-secret".into(),
            TaintLabel {
                source: "env.API_KEY".into(),
                level: TaintLevel::Secret,
            },
        );

        let inv = make_invocation("What is the weather today?");
        let caps = ActiveCapabilities::empty();
        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_allowed());
    }

    #[tokio::test]
    async fn escalates_internal_data() {
        let tracker = Arc::new(TaintTracker::new());
        let mut interceptor = LlmRelayInterceptor::new(tracker);
        interceptor.register_secret(
            "user@company.com".into(),
            TaintLabel {
                source: "pii.email".into(),
                level: TaintLevel::Internal,
            },
        );

        let inv = make_invocation("Send email to user@company.com");
        let caps = ActiveCapabilities::empty();
        let result = interceptor.intercept(&inv, &caps).await;
        assert!(matches!(result, InterceptionResult::Escalate(_)));
    }
}
