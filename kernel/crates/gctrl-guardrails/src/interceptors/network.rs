use async_trait::async_trait;
use gctrl_core::{ActiveCapabilities, CapabilityKind};

use crate::interception::{InterceptionResult, ToolInterceptor, ToolInvocation};

pub struct NetworkInterceptor;

#[async_trait]
impl ToolInterceptor for NetworkInterceptor {
    fn name(&self) -> &str {
        "network"
    }

    async fn intercept(
        &self,
        invocation: &ToolInvocation,
        caps: &ActiveCapabilities,
    ) -> InterceptionResult {
        if invocation.affected_hosts.is_empty() {
            return InterceptionResult::Proceed;
        }

        let scope = match caps.narrowest_scope(&CapabilityKind::Network) {
            Some(s) => s,
            None => {
                return InterceptionResult::Deny("no network capability granted".into())
            }
        };

        for host in &invocation.affected_hosts {
            if !scope.permits_host(host) {
                tracing::warn!(%host, "network access denied — outside permitted scope");
                return InterceptionResult::Deny(
                    "network access denied".into(),
                );
            }
        }

        InterceptionResult::Proceed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gctrl_core::*;

    fn caps_with_hosts(patterns: Vec<&str>) -> ActiveCapabilities {
        ActiveCapabilities::new(vec![CapabilityGrant {
            id: "test".into(),
            kind: CapabilityKind::Network,
            scope: CapabilityScope::Hosts {
                patterns: patterns.into_iter().map(String::from).collect(),
            },
            level: GrantLevel::Session,
            parent_grant_id: None,
            granted_to: "agent".into(),
            granted_at: chrono::Utc::now(),
            revoked_at: None,
        }])
    }

    #[tokio::test]
    async fn allows_permitted_host() {
        let interceptor = NetworkInterceptor;
        let caps = caps_with_hosts(vec!["*.anthropic.com"]);
        let inv = ToolInvocation {
            tool_name: "WebFetch".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec!["api.anthropic.com".into()],
            affected_commands: vec![],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_allowed());
    }

    #[tokio::test]
    async fn denies_unpermitted_host() {
        let interceptor = NetworkInterceptor;
        let caps = caps_with_hosts(vec!["*.anthropic.com"]);
        let inv = ToolInvocation {
            tool_name: "WebFetch".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec!["evil.com".into()],
            affected_commands: vec![],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_denied());
    }
}
