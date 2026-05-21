use std::sync::Arc;

use gctrl_core::{CapabilityGrant, CapabilityKind, CapabilityScope, GrantLevel, SessionId};

use crate::cap_engine::{CapabilityEngine, CapabilityError};

pub struct ScopedCapability {
    pub grant: CapabilityGrant,
    _guard: ScopeGuard,
}

impl ScopedCapability {
    pub fn kind(&self) -> &CapabilityKind {
        &self.grant.kind
    }

    pub fn scope(&self) -> &CapabilityScope {
        &self.grant.scope
    }
}

struct ScopeGuard {
    engine: Arc<CapabilityEngine>,
    token_nonce: u128,
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        self.engine.revoke_token(self.token_nonce);
    }
}

impl CapabilityEngine {
    pub fn enter_scope(
        self: &Arc<Self>,
        session_id: &SessionId,
        kind: CapabilityKind,
        scope: CapabilityScope,
        expires_in: Option<chrono::Duration>,
    ) -> Result<ScopedCapability, CapabilityError> {
        let nonce = self.mint_scoped_token(session_id, kind.clone(), scope.clone(), expires_in)?;

        let grant = CapabilityGrant {
            id: format!("scoped:{}:{nonce}", session_id.0),
            kind: kind.clone(),
            scope: scope.clone(),
            level: GrantLevel::Scoped,
            parent_grant_id: None,
            granted_to: session_id.0.clone(),
            granted_at: chrono::Utc::now(),
            revoked_at: None,
        };

        Ok(ScopedCapability {
            grant,
            _guard: ScopeGuard {
                engine: Arc::clone(self),
                token_nonce: nonce,
            },
        })
    }

    pub async fn with_scoped<F, Fut, T>(
        self: &Arc<Self>,
        session_id: &SessionId,
        kind: CapabilityKind,
        scope: CapabilityScope,
        f: F,
    ) -> Result<T, CapabilityError>
    where
        F: FnOnce(&ScopedCapability) -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let scoped = self.enter_scope(session_id, kind, scope, None)?;
        let result = f(&scoped).await;
        // scoped drops here → token is revoked
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taint::TaintTracker;

    #[tokio::test]
    async fn scoped_capability_auto_revokes_on_drop() {
        let taint = Arc::new(TaintTracker::new());
        let engine = Arc::new(CapabilityEngine::new(taint));
        let session_id = SessionId("test".into());

        engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        // Enter scope, then drop
        {
            let _scoped = engine
                .enter_scope(
                    &session_id,
                    CapabilityKind::LlmRelay,
                    CapabilityScope::Full,
                    None,
                )
                .unwrap();

            // Token should be valid inside scope
            assert!(engine.has_valid_token(
                &session_id,
                &CapabilityKind::LlmRelay,
                &CapabilityScope::Full,
            ));
            // _scoped drops here
        }

        // Token should be revoked after scope exits
        assert!(!engine.has_valid_token(
            &session_id,
            &CapabilityKind::LlmRelay,
            &CapabilityScope::Full,
        ));
    }

    #[tokio::test]
    async fn with_scoped_executes_and_revokes() {
        let taint = Arc::new(TaintTracker::new());
        let engine = Arc::new(CapabilityEngine::new(taint));
        let session_id = SessionId("test".into());

        engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        let result = engine
            .with_scoped(
                &session_id,
                CapabilityKind::LlmRelay,
                CapabilityScope::Full,
                |_scoped| async { 42 },
            )
            .await
            .unwrap();

        assert_eq!(result, 42);

        // After with_scoped completes, token should be revoked
        assert!(!engine.has_valid_token(
            &session_id,
            &CapabilityKind::LlmRelay,
            &CapabilityScope::Full,
        ));
    }

    #[tokio::test]
    async fn scoped_rejects_scope_exceeding_session() {
        let taint = Arc::new(TaintTracker::new());
        let engine = Arc::new(CapabilityEngine::new(taint));
        let session_id = SessionId("test".into());

        // Grant filesystem with narrow scope
        {
            engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

            // Manually add a filesystem grant with narrow scope
            let mut grants = engine.grants.lock().unwrap();
            grants.entry(session_id.clone()).or_default().push(CapabilityGrant {
                id: "session:fs".into(),
                kind: CapabilityKind::FileSystem,
                scope: CapabilityScope::Paths {
                    prefixes: vec!["/project".into()],
                },
                level: GrantLevel::Session,
                parent_grant_id: None,
                granted_to: "test".into(),
                granted_at: chrono::Utc::now(),
                revoked_at: None,
            });
        }

        // Try to enter scope with wider path → should fail
        let result = engine.enter_scope(
            &session_id,
            CapabilityKind::FileSystem,
            CapabilityScope::Paths {
                prefixes: vec!["/etc".into()],
            },
            None,
        );

        assert!(matches!(
            result,
            Err(CapabilityError::ScopeExceedsParent { .. })
        ));
    }
}
