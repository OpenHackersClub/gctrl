use std::path::Path;

use async_trait::async_trait;
use gctrl_core::{ActiveCapabilities, CapabilityKind};

use crate::interception::{InterceptionResult, ToolInterceptor, ToolInvocation};

pub struct FilesystemInterceptor;

fn canonicalize_or_logical(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        // File may not exist yet (e.g. Write to new file). Use logical normalization:
        // resolve ".." and "." components without requiring filesystem access.
        let mut components = Vec::new();
        for comp in path.components() {
            match comp {
                std::path::Component::ParentDir => { components.pop(); }
                std::path::Component::CurDir => {}
                other => components.push(other),
            }
        }
        components.iter().collect()
    })
}

#[async_trait]
impl ToolInterceptor for FilesystemInterceptor {
    fn name(&self) -> &str {
        "filesystem"
    }

    async fn intercept(
        &self,
        invocation: &ToolInvocation,
        caps: &ActiveCapabilities,
    ) -> InterceptionResult {
        if invocation.affected_paths.is_empty() {
            return InterceptionResult::Proceed;
        }

        let scope = match caps.narrowest_scope(&CapabilityKind::FileSystem) {
            Some(s) => s,
            None => {
                return InterceptionResult::Deny(
                    "no filesystem capability granted".into(),
                )
            }
        };

        for path in &invocation.affected_paths {
            let resolved = canonicalize_or_logical(path);
            if !scope.permits_path(&resolved) {
                tracing::warn!(path = %path.display(), resolved = %resolved.display(), "filesystem access denied — outside permitted scope");
                return InterceptionResult::Deny(
                    "filesystem access denied".into(),
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
    use std::path::PathBuf;

    fn caps_with_path(path: &str) -> ActiveCapabilities {
        ActiveCapabilities::new(vec![CapabilityGrant {
            id: "test".into(),
            kind: CapabilityKind::FileSystem,
            scope: CapabilityScope::Paths {
                prefixes: vec![PathBuf::from(path)],
            },
            level: GrantLevel::Session,
            parent_grant_id: None,
            granted_to: "agent".into(),
            granted_at: chrono::Utc::now(),
            revoked_at: None,
        }])
    }

    #[tokio::test]
    async fn allows_path_within_scope() {
        let interceptor = FilesystemInterceptor;
        let caps = caps_with_path("/project");
        let inv = ToolInvocation {
            tool_name: "Write".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![PathBuf::from("/project/src/main.rs")],
            affected_hosts: vec![],
            affected_commands: vec![],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_allowed());
    }

    #[tokio::test]
    async fn denies_path_outside_scope() {
        let interceptor = FilesystemInterceptor;
        let caps = caps_with_path("/project");
        let inv = ToolInvocation {
            tool_name: "Write".into(),
            session_id: SessionId("s".into()),
            agent_name: "a".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![PathBuf::from("/etc/shadow")],
            affected_hosts: vec![],
            affected_commands: vec![],
        };

        let result = interceptor.intercept(&inv, &caps).await;
        assert!(result.is_denied());
    }
}
