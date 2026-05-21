use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use gctrl_core::{ActiveCapabilities, CapabilityKind, CapabilityScope, SessionId};

use crate::cap_engine::CapabilityEngine;
use crate::engine::GuardrailEngine;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolInvocation {
    pub tool_name: String,
    pub session_id: SessionId,
    pub agent_name: String,
    pub parameters: serde_json::Value,
    pub affected_paths: Vec<PathBuf>,
    pub affected_hosts: Vec<String>,
    pub affected_commands: Vec<String>,
}

impl ToolInvocation {
    pub fn to_execution_context(&self) -> gctrl_core::ExecutionContext {
        gctrl_core::ExecutionContext {
            session_id: self.session_id.clone(),
            agent_name: self.agent_name.clone(),
            current_cost_usd: 0.0,
            span_count: 0,
            recent_operations: vec![self.tool_name.clone()],
            pending_command: self.affected_commands.first().cloned(),
            pending_diff_lines: None,
        }
    }

    pub fn required_capability(&self) -> Option<(CapabilityKind, CapabilityScope)> {
        match self.tool_name.as_str() {
            "Bash" | "exec" | "process" => {
                let scope = if self.affected_commands.is_empty() {
                    CapabilityScope::Full
                } else {
                    CapabilityScope::Commands {
                        patterns: self.affected_commands.clone(),
                    }
                };
                Some((CapabilityKind::Process, scope))
            }
            "Read" | "Write" | "Edit" | "file_read" | "file_write" => {
                let scope = if self.affected_paths.is_empty() {
                    CapabilityScope::Full
                } else {
                    CapabilityScope::Paths {
                        prefixes: self.affected_paths.clone(),
                    }
                };
                Some((CapabilityKind::FileSystem, scope))
            }
            "WebFetch" | "http_get" | "http_post" | "network" => {
                let scope = if self.affected_hosts.is_empty() {
                    CapabilityScope::Full
                } else {
                    CapabilityScope::Hosts {
                        patterns: self.affected_hosts.clone(),
                    }
                };
                Some((CapabilityKind::Network, scope))
            }
            "llm_relay" | "chat" | "complete" => {
                Some((CapabilityKind::LlmRelay, CapabilityScope::Full))
            }
            "vault_write" => Some((CapabilityKind::VaultWrite, CapabilityScope::Full)),
            "secrets" | "secret_get" => Some((CapabilityKind::Secrets, CapabilityScope::Full)),
            "browser" | "cdp" => Some((CapabilityKind::BrowserCdp, CapabilityScope::Full)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum InterceptionResult {
    Proceed,
    ProceedWithRedaction(serde_json::Value),
    Deny(String),
    Escalate(String),
}

impl InterceptionResult {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Proceed | Self::ProceedWithRedaction(_))
    }

    pub fn is_denied(&self) -> bool {
        matches!(self, Self::Deny(_))
    }
}

#[async_trait]
pub trait ToolInterceptor: Send + Sync {
    fn name(&self) -> &str;
    async fn intercept(
        &self,
        invocation: &ToolInvocation,
        caps: &ActiveCapabilities,
    ) -> InterceptionResult;
}

pub struct CapabilityGuardrailEngine {
    policy_engine: GuardrailEngine,
    cap_engine: Arc<CapabilityEngine>,
    interceptors: Vec<Box<dyn ToolInterceptor>>,
}

impl CapabilityGuardrailEngine {
    pub fn new(policy_engine: GuardrailEngine, cap_engine: Arc<CapabilityEngine>) -> Self {
        Self {
            policy_engine,
            cap_engine,
            interceptors: Vec::new(),
        }
    }

    pub fn add_interceptor(&mut self, interceptor: Box<dyn ToolInterceptor>) {
        self.interceptors.push(interceptor);
    }

    pub fn policy_engine(&self) -> &GuardrailEngine {
        &self.policy_engine
    }

    pub fn cap_engine(&self) -> &Arc<CapabilityEngine> {
        &self.cap_engine
    }

    pub async fn evaluate_tool_call(&self, invocation: &ToolInvocation) -> InterceptionResult {
        // Step 1: Run existing policies
        let ctx = invocation.to_execution_context();
        if self.policy_engine.is_denied(&ctx) {
            let decisions = self.policy_engine.evaluate(&ctx);
            let reason = decisions
                .iter()
                .find_map(|(name, d)| match d {
                    gctrl_core::PolicyDecision::Deny(msg) => Some(format!("{name}: {msg}")),
                    _ => None,
                })
                .unwrap_or_else(|| "policy denied".into());
            return InterceptionResult::Deny(reason);
        }

        // Step 2: Check capability requirements
        let caps = self.cap_engine.active_for_session(&invocation.session_id);
        if let Some((required_kind, required_scope)) = invocation.required_capability() {
            if !caps.has_scoped(&required_kind, &required_scope) {
                return InterceptionResult::Deny(format!(
                    "missing capability {:?} with required scope",
                    required_kind
                ));
            }
        }

        // Step 3: Run interceptor chain
        for interceptor in &self.interceptors {
            let result = interceptor.intercept(invocation, &caps).await;
            match result {
                InterceptionResult::Proceed => continue,
                other => return other,
            }
        }

        InterceptionResult::Proceed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gctrl_core::{CapabilityGrant, GrantLevel};

    #[tokio::test]
    async fn evaluate_allows_when_capability_granted() {
        let taint = Arc::new(crate::taint::TaintTracker::new());
        let cap_engine = Arc::new(CapabilityEngine::new(taint));

        let session_id = SessionId("test".into());
        cap_engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        let engine = CapabilityGuardrailEngine::new(GuardrailEngine::new(), cap_engine);

        let invocation = ToolInvocation {
            tool_name: "llm_relay".into(),
            session_id: session_id.clone(),
            agent_name: "claude".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec![],
            affected_commands: vec![],
        };

        let result = engine.evaluate_tool_call(&invocation).await;
        assert!(result.is_allowed());
    }

    #[tokio::test]
    async fn evaluate_denies_when_capability_missing() {
        let taint = Arc::new(crate::taint::TaintTracker::new());
        let cap_engine = Arc::new(CapabilityEngine::new(taint));

        let session_id = SessionId("test".into());
        // No grants registered for this session
        {
            let mut grants = cap_engine.grants.lock().unwrap();
            grants.insert(session_id.clone(), vec![]);
        }

        let engine = CapabilityGuardrailEngine::new(GuardrailEngine::new(), cap_engine);

        let invocation = ToolInvocation {
            tool_name: "Bash".into(),
            session_id: session_id.clone(),
            agent_name: "claude".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec![],
            affected_hosts: vec![],
            affected_commands: vec!["rm -rf /".into()],
        };

        let result = engine.evaluate_tool_call(&invocation).await;
        assert!(result.is_denied());
    }

    #[tokio::test]
    async fn evaluate_denies_when_scope_insufficient() {
        let taint = Arc::new(crate::taint::TaintTracker::new());
        let cap_engine = Arc::new(CapabilityEngine::new(taint));

        let session_id = SessionId("test".into());
        {
            let mut grants = cap_engine.grants.lock().unwrap();
            grants.insert(
                session_id.clone(),
                vec![CapabilityGrant {
                    id: "test".into(),
                    kind: CapabilityKind::FileSystem,
                    scope: CapabilityScope::Paths {
                        prefixes: vec!["/project".into()],
                    },
                    level: GrantLevel::Session,
                    parent_grant_id: None,
                    granted_to: "agent".into(),
                    granted_at: chrono::Utc::now(),
                    revoked_at: None,
                }],
            );
        }

        let engine = CapabilityGuardrailEngine::new(GuardrailEngine::new(), cap_engine);

        let invocation = ToolInvocation {
            tool_name: "Write".into(),
            session_id: session_id.clone(),
            agent_name: "claude".into(),
            parameters: serde_json::Value::Null,
            affected_paths: vec!["/etc/passwd".into()],
            affected_hosts: vec![],
            affected_commands: vec![],
        };

        let result = engine.evaluate_tool_call(&invocation).await;
        assert!(result.is_denied());
    }
}
