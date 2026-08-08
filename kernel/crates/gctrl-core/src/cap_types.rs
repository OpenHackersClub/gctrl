use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::SessionId;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    FileSystem,
    Network,
    Process,
    LlmRelay,
    VaultWrite,
    Secrets,
    BrowserCdp,
    Scheduler,
    Custom(String),
}

impl CapabilityKind {
    pub fn from_registry_id(id: &str) -> Self {
        match id {
            "llm" => Self::LlmRelay,
            "vault.write" => Self::VaultWrite,
            "vault.sync" => Self::VaultWrite,
            "secrets" => Self::Secrets,
            "scheduler" => Self::Scheduler,
            "browser.cdp" => Self::BrowserCdp,
            "search.brave" => Self::Network,
            "gcal" => Self::Network,
            _ if id.starts_with("deliverer.") => Self::Network,
            _ => Self::Custom(id.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum CapabilityScope {
    Paths { prefixes: Vec<PathBuf> },
    Hosts { patterns: Vec<String> },
    Commands { patterns: Vec<String> },
    Full,
    None,
}

impl CapabilityScope {
    pub fn is_subset_of(&self, parent: &Self) -> bool {
        match parent {
            Self::Full => true,
            Self::None => matches!(self, Self::None),
            Self::Paths { prefixes: parent_prefixes } => match self {
                Self::Paths { prefixes: child_prefixes } => child_prefixes
                    .iter()
                    .all(|child| parent_prefixes.iter().any(|p| child.starts_with(p))),
                Self::None => true,
                _ => false,
            },
            Self::Hosts { patterns: parent_patterns } => match self {
                Self::Hosts { patterns: child_patterns } => child_patterns
                    .iter()
                    .all(|child| parent_patterns.iter().any(|p| host_matches(child, p))),
                Self::None => true,
                _ => false,
            },
            Self::Commands { patterns: parent_patterns } => match self {
                Self::Commands { patterns: child_patterns } => child_patterns
                    .iter()
                    .all(|child| parent_patterns.iter().any(|p| command_matches(child, p))),
                Self::None => true,
                _ => false,
            },
        }
    }

    pub fn permits_path(&self, path: &std::path::Path) -> bool {
        match self {
            Self::Full => true,
            Self::Paths { prefixes } => prefixes.iter().any(|p| path.starts_with(p)),
            _ => false,
        }
    }

    pub fn permits_host(&self, host: &str) -> bool {
        match self {
            Self::Full => true,
            Self::Hosts { patterns } => patterns.iter().any(|p| host_matches(host, p)),
            _ => false,
        }
    }

    pub fn permits_command(&self, cmd: &str) -> bool {
        match self {
            Self::Full => true,
            Self::Commands { patterns } => patterns.iter().any(|p| command_matches(cmd, p)),
            _ => false,
        }
    }
}

fn host_matches(host: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host == suffix || host.ends_with(&format!(".{suffix}"))
    } else {
        host == pattern
    }
}

fn command_matches(cmd: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        cmd.starts_with(prefix)
    } else {
        cmd == pattern
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantLevel {
    Manifest,
    Session,
    Scoped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityGrant {
    pub id: String,
    pub kind: CapabilityKind,
    pub scope: CapabilityScope,
    pub level: GrantLevel,
    pub parent_grant_id: Option<String>,
    pub granted_to: String,
    pub granted_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl CapabilityGrant {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

pub struct CapabilityToken {
    nonce: u128,
    pub kind: CapabilityKind,
    pub scope: CapabilityScope,
    pub session_id: SessionId,
    pub granted_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl CapabilityToken {
    pub fn new(
        nonce: u128,
        kind: CapabilityKind,
        scope: CapabilityScope,
        session_id: SessionId,
        expires_at: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            nonce,
            kind,
            scope,
            session_id,
            granted_at: Utc::now(),
            expires_at,
        }
    }

    pub fn nonce(&self) -> u128 {
        self.nonce
    }

    pub fn is_expired(&self) -> bool {
        self.expires_at.map_or(false, |exp| Utc::now() > exp)
    }

    pub fn is_valid(&self) -> bool {
        !self.is_expired()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityRequest {
    pub kind: CapabilityKind,
    pub scope: CapabilityScope,
}

pub struct ActiveCapabilities {
    grants: Vec<CapabilityGrant>,
}

impl ActiveCapabilities {
    pub fn new(grants: Vec<CapabilityGrant>) -> Self {
        Self { grants }
    }

    pub fn empty() -> Self {
        Self { grants: vec![] }
    }

    pub fn has(&self, kind: &CapabilityKind) -> bool {
        self.grants
            .iter()
            .any(|g| g.is_active() && &g.kind == kind)
    }

    pub fn has_scoped(&self, kind: &CapabilityKind, required_scope: &CapabilityScope) -> bool {
        self.grants.iter().any(|g| {
            g.is_active() && &g.kind == kind && required_scope.is_subset_of(&g.scope)
        })
    }

    pub fn narrowest_scope(&self, kind: &CapabilityKind) -> Option<&CapabilityScope> {
        self.grants
            .iter()
            .filter(|g| g.is_active() && &g.kind == kind)
            .min_by_key(|g| match &g.level {
                GrantLevel::Scoped => 0,
                GrantLevel::Session => 1,
                GrantLevel::Manifest => 2,
            })
            .map(|g| &g.scope)
    }

    pub fn grants(&self) -> &[CapabilityGrant] {
        &self.grants
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_scope_is_superset_of_everything() {
        let full = CapabilityScope::Full;
        let paths = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/tmp")],
        };
        let hosts = CapabilityScope::Hosts {
            patterns: vec!["example.com".into()],
        };
        let none = CapabilityScope::None;

        assert!(paths.is_subset_of(&full));
        assert!(hosts.is_subset_of(&full));
        assert!(none.is_subset_of(&full));
        assert!(full.is_subset_of(&full));
    }

    #[test]
    fn none_scope_is_subset_of_none_only() {
        let none = CapabilityScope::None;
        let paths = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/tmp")],
        };
        assert!(none.is_subset_of(&none));
        assert!(!paths.is_subset_of(&none));
    }

    #[test]
    fn path_scope_narrowing() {
        let parent = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/project")],
        };
        let child_ok = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/project/src")],
        };
        let child_bad = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/etc")],
        };

        assert!(child_ok.is_subset_of(&parent));
        assert!(!child_bad.is_subset_of(&parent));
    }

    #[test]
    fn host_pattern_matching() {
        assert!(host_matches("api.example.com", "*.example.com"));
        assert!(host_matches("example.com", "*.example.com"));
        assert!(!host_matches("evil.com", "*.example.com"));
        assert!(host_matches("anything", "*"));
    }

    #[test]
    fn command_pattern_matching() {
        assert!(command_matches("ls", "ls"));
        assert!(command_matches("git push", "git *"));
        assert!(!command_matches("rm -rf /", "git *"));
        assert!(command_matches("anything", "*"));
    }

    #[test]
    fn host_scope_narrowing() {
        let parent = CapabilityScope::Hosts {
            patterns: vec!["*.example.com".into()],
        };
        let child_ok = CapabilityScope::Hosts {
            patterns: vec!["api.example.com".into()],
        };
        let child_bad = CapabilityScope::Hosts {
            patterns: vec!["evil.com".into()],
        };

        assert!(child_ok.is_subset_of(&parent));
        assert!(!child_bad.is_subset_of(&parent));
    }

    #[test]
    fn active_capabilities_query() {
        let caps = ActiveCapabilities::new(vec![CapabilityGrant {
            id: "test-grant".into(),
            kind: CapabilityKind::FileSystem,
            scope: CapabilityScope::Paths {
                prefixes: vec![PathBuf::from("/project")],
            },
            level: GrantLevel::Session,
            parent_grant_id: None,
            granted_to: "agent".into(),
            granted_at: Utc::now(),
            revoked_at: None,
        }]);

        assert!(caps.has(&CapabilityKind::FileSystem));
        assert!(!caps.has(&CapabilityKind::Network));

        let scope_ok = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/project/src")],
        };
        assert!(caps.has_scoped(&CapabilityKind::FileSystem, &scope_ok));

        let scope_bad = CapabilityScope::Paths {
            prefixes: vec![PathBuf::from("/etc")],
        };
        assert!(!caps.has_scoped(&CapabilityKind::FileSystem, &scope_bad));
    }

    #[test]
    fn capability_token_expiry() {
        let token = CapabilityToken::new(
            42,
            CapabilityKind::Network,
            CapabilityScope::Full,
            SessionId("s1".into()),
            Some(Utc::now() - chrono::Duration::seconds(1)),
        );
        assert!(token.is_expired());
        assert!(!token.is_valid());

        let token_valid = CapabilityToken::new(
            43,
            CapabilityKind::Network,
            CapabilityScope::Full,
            SessionId("s1".into()),
            Some(Utc::now() + chrono::Duration::seconds(60)),
        );
        assert!(!token_valid.is_expired());
        assert!(token_valid.is_valid());
    }
}
