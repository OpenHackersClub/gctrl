use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use gctrl_core::{
    ActiveCapabilities, CapabilityGrant, CapabilityKind, CapabilityRequest, CapabilityScope,
    CapabilityToken, GrantLevel, SessionId,
};
use uuid::Uuid;

use crate::taint::TaintTracker;

#[derive(Debug, thiserror::Error)]
pub enum CapabilityError {
    #[error("requested scope exceeds parent grant scope")]
    ScopeExceedsParent {
        requested: CapabilityScope,
        parent: CapabilityScope,
    },

    #[error("no manifest-level grant for the requested capability")]
    NoManifestGrant { kind: CapabilityKind },

    #[error("no session-level grant for the requested capability")]
    NoSessionGrant {
        kind: CapabilityKind,
        session_id: SessionId,
    },

    #[error("grant already revoked")]
    AlreadyRevoked { grant_id: String },

    #[error("session has no registered grants")]
    UnknownSession(SessionId),
}

pub struct CapabilityEngine {
    pub(crate) grants: Mutex<HashMap<SessionId, Vec<CapabilityGrant>>>,
    pub(crate) active_tokens: Mutex<HashMap<SessionId, Vec<CapabilityToken>>>,
    taint_tracker: Arc<TaintTracker>,
}

impl CapabilityEngine {
    pub fn new(taint_tracker: Arc<TaintTracker>) -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
            active_tokens: Mutex::new(HashMap::new()),
            taint_tracker,
        }
    }

    pub fn taint_tracker(&self) -> &Arc<TaintTracker> {
        &self.taint_tracker
    }

    pub fn grant_manifest(
        &self,
        session_id: &SessionId,
        app_name: &str,
        capability_ids: impl Iterator<Item = (&str, bool)>,
    ) -> Vec<CapabilityGrant> {
        let mut session_grants = Vec::new();

        for (cap_id, _required) in capability_ids {
            let grant = CapabilityGrant {
                id: format!("manifest:{}:{}", app_name, cap_id),
                kind: CapabilityKind::from_registry_id(cap_id),
                scope: CapabilityScope::Full,
                level: GrantLevel::Manifest,
                parent_grant_id: None,
                granted_to: app_name.to_string(),
                granted_at: Utc::now(),
                revoked_at: None,
            };
            session_grants.push(grant);
        }

        let mut grants = self.grants.lock().unwrap();
        grants
            .entry(session_id.clone())
            .or_default()
            .extend(session_grants.clone());

        session_grants
    }

    pub fn grant_session(
        &self,
        session_id: &SessionId,
        requests: &[CapabilityRequest],
    ) -> Result<Vec<CapabilityGrant>, CapabilityError> {
        let mut grants = self.grants.lock().unwrap();
        let manifest_grants = grants
            .get(session_id)
            .ok_or_else(|| CapabilityError::UnknownSession(session_id.clone()))?;

        let mut new_grants = Vec::new();

        for req in requests {
            let parent = manifest_grants
                .iter()
                .find(|g| g.kind == req.kind && g.level == GrantLevel::Manifest && g.is_active())
                .ok_or_else(|| CapabilityError::NoManifestGrant {
                    kind: req.kind.clone(),
                })?;

            if !req.scope.is_subset_of(&parent.scope) {
                return Err(CapabilityError::ScopeExceedsParent {
                    requested: req.scope.clone(),
                    parent: parent.scope.clone(),
                });
            }

            let grant = CapabilityGrant {
                id: format!("session:{}:{}", session_id.0, Uuid::new_v4()),
                kind: req.kind.clone(),
                scope: req.scope.clone(),
                level: GrantLevel::Session,
                parent_grant_id: Some(parent.id.clone()),
                granted_to: session_id.0.clone(),
                granted_at: Utc::now(),
                revoked_at: None,
            };
            new_grants.push(grant);
        }

        grants
            .entry(session_id.clone())
            .or_default()
            .extend(new_grants.clone());

        Ok(new_grants)
    }

    pub fn mint_scoped_token(
        &self,
        session_id: &SessionId,
        kind: CapabilityKind,
        scope: CapabilityScope,
        expires_in: Option<chrono::Duration>,
    ) -> Result<u128, CapabilityError> {
        let grants = self.grants.lock().unwrap();
        let session_grants = grants
            .get(session_id)
            .ok_or_else(|| CapabilityError::UnknownSession(session_id.clone()))?;

        let parent = session_grants
            .iter()
            .find(|g| {
                g.kind == kind
                    && (g.level == GrantLevel::Session || g.level == GrantLevel::Manifest)
                    && g.is_active()
            })
            .ok_or_else(|| CapabilityError::NoSessionGrant {
                kind: kind.clone(),
                session_id: session_id.clone(),
            })?;

        if !scope.is_subset_of(&parent.scope) {
            return Err(CapabilityError::ScopeExceedsParent {
                requested: scope,
                parent: parent.scope.clone(),
            });
        }

        let nonce = rand_nonce();
        let expires_at = expires_in.map(|d| Utc::now() + d);
        let token = CapabilityToken::new(nonce, kind, scope, session_id.clone(), expires_at);

        drop(grants);
        let mut tokens = self.active_tokens.lock().unwrap();
        tokens.entry(session_id.clone()).or_default().push(token);

        Ok(nonce)
    }

    pub fn revoke_token(&self, nonce: u128) {
        let mut tokens = self.active_tokens.lock().unwrap();
        for session_tokens in tokens.values_mut() {
            session_tokens.retain(|t| t.nonce() != nonce);
        }
    }

    pub fn revoke_grant(&self, grant_id: &str) -> Result<(), CapabilityError> {
        let mut grants = self.grants.lock().unwrap();
        for session_grants in grants.values_mut() {
            if let Some(grant) = session_grants.iter_mut().find(|g| g.id == grant_id) {
                if grant.revoked_at.is_some() {
                    return Err(CapabilityError::AlreadyRevoked {
                        grant_id: grant_id.to_string(),
                    });
                }
                grant.revoked_at = Some(Utc::now());
                return Ok(());
            }
        }
        Ok(())
    }

    pub fn revoke_session(&self, session_id: &SessionId) {
        let mut grants = self.grants.lock().unwrap();
        if let Some(session_grants) = grants.get_mut(session_id) {
            let now = Utc::now();
            for grant in session_grants.iter_mut() {
                if grant.revoked_at.is_none() {
                    grant.revoked_at = Some(now);
                }
            }
        }

        let mut tokens = self.active_tokens.lock().unwrap();
        tokens.remove(session_id);
    }

    pub fn active_for_session(&self, session_id: &SessionId) -> ActiveCapabilities {
        let grants = self.grants.lock().unwrap();
        match grants.get(session_id) {
            Some(session_grants) => {
                let active: Vec<_> = session_grants
                    .iter()
                    .filter(|g| g.is_active())
                    .cloned()
                    .collect();
                ActiveCapabilities::new(active)
            }
            None => ActiveCapabilities::empty(),
        }
    }

    pub fn has_valid_token(
        &self,
        session_id: &SessionId,
        kind: &CapabilityKind,
        scope: &CapabilityScope,
    ) -> bool {
        let tokens = self.active_tokens.lock().unwrap();
        tokens.get(session_id).map_or(false, |session_tokens| {
            session_tokens
                .iter()
                .any(|t| t.is_valid() && &t.kind == kind && scope.is_subset_of(&t.scope))
        })
    }
}

fn rand_nonce() -> u128 {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("CSPRNG failed — cannot mint capability tokens");
    u128::from_le_bytes(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (CapabilityEngine, SessionId) {
        let tracker = Arc::new(TaintTracker::new());
        let engine = CapabilityEngine::new(tracker);
        let session_id = SessionId("test-session".into());
        (engine, session_id)
    }

    #[test]
    fn grant_manifest_creates_full_scope_grants() {
        let (engine, session_id) = setup();
        let caps = vec![("llm", true), ("vault.write", true)];

        let grants = engine.grant_manifest(&session_id, "demo-app", caps.into_iter());

        assert_eq!(grants.len(), 2);
        assert!(grants.iter().all(|g| g.level == GrantLevel::Manifest));
        assert!(grants.iter().all(|g| g.scope == CapabilityScope::Full));
    }

    #[test]
    fn grant_session_narrows_scope() {
        let (engine, session_id) = setup();
        engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        let requests = vec![CapabilityRequest {
            kind: CapabilityKind::LlmRelay,
            scope: CapabilityScope::Hosts {
                patterns: vec!["api.anthropic.com".into()],
            },
        }];

        let grants = engine.grant_session(&session_id, &requests).unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].level, GrantLevel::Session);
    }

    #[test]
    fn grant_session_rejects_scope_exceeding_parent() {
        let (engine, session_id) = setup();
        // Grant manifest with path scope (not Full, to test narrowing)
        {
            let mut grants = engine.grants.lock().unwrap();
            grants.entry(session_id.clone()).or_default().push(CapabilityGrant {
                id: "manifest:app:fs".into(),
                kind: CapabilityKind::FileSystem,
                scope: CapabilityScope::Paths {
                    prefixes: vec!["/project".into()],
                },
                level: GrantLevel::Manifest,
                parent_grant_id: None,
                granted_to: "app".into(),
                granted_at: Utc::now(),
                revoked_at: None,
            });
        }

        let requests = vec![CapabilityRequest {
            kind: CapabilityKind::FileSystem,
            scope: CapabilityScope::Paths {
                prefixes: vec!["/etc".into()],
            },
        }];

        let result = engine.grant_session(&session_id, &requests);
        assert!(matches!(result, Err(CapabilityError::ScopeExceedsParent { .. })));
    }

    #[test]
    fn mint_and_revoke_scoped_token() {
        let (engine, session_id) = setup();
        engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        let nonce = engine
            .mint_scoped_token(
                &session_id,
                CapabilityKind::LlmRelay,
                CapabilityScope::Full,
                None,
            )
            .unwrap();

        assert!(engine.has_valid_token(
            &session_id,
            &CapabilityKind::LlmRelay,
            &CapabilityScope::Full,
        ));

        engine.revoke_token(nonce);

        assert!(!engine.has_valid_token(
            &session_id,
            &CapabilityKind::LlmRelay,
            &CapabilityScope::Full,
        ));
    }

    #[test]
    fn revoke_session_removes_all() {
        let (engine, session_id) = setup();
        engine.grant_manifest(&session_id, "app", vec![("llm", true)].into_iter());

        let caps = engine.active_for_session(&session_id);
        assert!(caps.has(&CapabilityKind::LlmRelay));

        engine.revoke_session(&session_id);

        let caps = engine.active_for_session(&session_id);
        assert!(!caps.has(&CapabilityKind::LlmRelay));
    }
}
