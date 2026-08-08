use std::sync::Arc;

use gctrl_core::{app_manifest::AppManifest, CapabilityGrant, SessionId};

use crate::cap_engine::CapabilityEngine;

pub fn grant_manifest_capabilities(
    engine: &Arc<CapabilityEngine>,
    manifest: &AppManifest,
    session_id: &SessionId,
) -> Vec<CapabilityGrant> {
    engine.grant_manifest(session_id, &manifest.app.name, manifest.all_capabilities())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taint::TaintTracker;
    use gctrl_core::{CapabilityKind, GrantLevel};

    fn test_manifest() -> AppManifest {
        AppManifest::parse(
            r#"
[app]
name = "test-app"
version = "0.1.0"

[entrypoint]
bin = "dist/main.js"
command = "test"
runtime = "node"

[requires.llm]
description = "LLM relay"

[requires.vault.write]

[optional."search.brave"]
"#,
        )
        .unwrap()
    }

    #[test]
    fn grants_all_manifest_capabilities() {
        let taint = Arc::new(TaintTracker::new());
        let engine = Arc::new(CapabilityEngine::new(taint));
        let session_id = SessionId("s1".into());
        let manifest = test_manifest();

        let grants = grant_manifest_capabilities(&engine, &manifest, &session_id);

        assert_eq!(grants.len(), 3); // llm + vault.write + search.brave
        assert!(grants.iter().all(|g| g.level == GrantLevel::Manifest));

        let kinds: Vec<_> = grants.iter().map(|g| &g.kind).collect();
        assert!(kinds.contains(&&CapabilityKind::LlmRelay));
        assert!(kinds.contains(&&CapabilityKind::VaultWrite));
        assert!(kinds.contains(&&CapabilityKind::Network)); // search.brave maps to Network
    }
}
