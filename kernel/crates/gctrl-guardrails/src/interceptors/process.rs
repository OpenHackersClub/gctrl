use async_trait::async_trait;
use gctrl_core::{ActiveCapabilities, CapabilityKind};

use crate::interception::{InterceptionResult, ToolInterceptor, ToolInvocation};

pub struct ProcessInterceptor;

#[async_trait]
impl ToolInterceptor for ProcessInterceptor {
    fn name(&self) -> &str {
        "process"
    }

    async fn intercept(
        &self,
        invocation: &ToolInvocation,
        caps: &ActiveCapabilities,
    ) -> InterceptionResult {
        if invocation.affected_commands.is_empty() {
            return InterceptionResult::Proceed;
        }

        let scope = match caps.narrowest_scope(&CapabilityKind::Process) {
            Some(s) => s,
            None => {
                return InterceptionResult::Deny(
                    "no process execution capability granted".into(),
                )
            }
        };

        for cmd in &invocation.affected_commands {
            if !scope.permits_command(cmd) {
                tracing::warn!(%cmd, "process execution denied — outside permitted scope");
                return InterceptionResult::Deny(
                    "process execution denied".into(),
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

    fn caps_with_commands(patterns: Vec<&str>) -> ActiveCapabilities {
        ActiveCapabilities::new(vec![CapabilityGrant {
            id: "test".into(),
            kind: CapabilityKind::Process,
            scope: CapabilityScope::Commands {
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
    async fn allows_permitted_command() {
        let interceptor = ProcessInterceptor;
        let caps = caps_with_commands(vec!["git *", "ls", "cat"]);
        let inv = ToolInvocation {
            tool_name: "Bash".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec![],
            affected_commands: vec!["git status".into()],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_allowed());
    }

    #[tokio::test]
    async fn denies_unpermitted_command() {
        let interceptor = ProcessInterceptor;
        let caps = caps_with_commands(vec!["git *", "ls"]);
        let inv = ToolInvocation {
            tool_name: "Bash".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec![],
            affected_commands: vec!["rm -rf /".into()],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_denied());
    }
}
