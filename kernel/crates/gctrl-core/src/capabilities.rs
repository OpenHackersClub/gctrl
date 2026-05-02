//! Capability registry — the kernel-published list of capabilities apps may
//! declare in their `gctrl-app.toml` manifests.
//!
//! Apps reference *capability ids* (e.g. `"llm"`, `"deliverer.telegram"`),
//! NOT driver names. The registry pins one default driver per capability id,
//! plus the HTTP route prefix the kernel mounts. The kernel can swap a
//! default driver implementation without manifest churn — the contract is
//! the capability, not the implementation.
//!
//! See `vault/specs/architecture/app-install-protocol.md` § Capability
//! Registry for the full contract.

/// One row in the capability registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityRegistration {
    /// Capability id used in manifests, e.g. `"llm"` or `"deliverer.telegram"`.
    /// Dotted-path. Kebab-case within each segment.
    pub id: &'static str,

    /// The kernel driver / module that fulfills this capability today.
    /// Apps never reference this directly — it shows up in `gctrl_app_bindings`
    /// rows (`driver_id` column) so operators can see what backs each capability.
    pub default_driver: &'static str,

    /// HTTP route prefix the kernel mounts for this capability. Apps' default
    /// Layer wires its port to this prefix.
    pub route_prefix: &'static str,

    /// One-sentence operator-facing description.
    pub description: &'static str,
}

/// Static registry of capabilities the kernel knows how to fulfill.
///
/// Order is **stable** — installers and `/api/app/capabilities` responses
/// emit entries in this order so external tooling can rely on a consistent
/// listing.
///
/// Adding a new capability requires a kernel update — manifests cannot
/// extend the registry. Removing a capability is a breaking change for
/// any installed app declaring it.
pub const REGISTRY: &[CapabilityRegistration] = &[
    CapabilityRegistration {
        id: "llm",
        default_driver: "driver-llm",
        route_prefix: "/api/llm",
        description: "LLM relay — Anthropic /v1/messages and OpenAI-compat \
                      /v1/chat/completions, with caching + cost capture.",
    },
    CapabilityRegistration {
        id: "deliverer.telegram",
        default_driver: "driver-telegram",
        route_prefix: "/api/telegram",
        description: "Telegram Bot API delivery — POST /api/telegram/send.",
    },
    CapabilityRegistration {
        id: "deliverer.discord",
        default_driver: "driver-discord",
        route_prefix: "/api/discord",
        description: "Discord webhook delivery — POST /api/discord/send.",
    },
    CapabilityRegistration {
        id: "vault.write",
        default_driver: "kernel-vault-fs",
        route_prefix: "/api/vault",
        description: "Atomic markdown writes against the kernel-owned vault \
                      root + content-hash watcher index.",
    },
    CapabilityRegistration {
        id: "vault.sync",
        default_driver: "gctrl-sync.vault",
        route_prefix: "/api/sync/vault",
        description: "Per-project-key sync to R2 (push/pull) backed by the \
                      kernel's R2Client.",
    },
    CapabilityRegistration {
        id: "secrets",
        default_driver: "driver-secrets",
        route_prefix: "/api/secrets",
        description: "Read-only secret resolution — apps call \
                      SecretsService.get; the kernel materializes values from \
                      its backing store (env / keychain / cloud bindings).",
    },
    CapabilityRegistration {
        id: "scheduler",
        default_driver: "kernel-scheduler",
        route_prefix: "/api/schedules",
        description: "Cron-style task scheduling (registered via [[schedule]] \
                      in the manifest).",
    },
    CapabilityRegistration {
        id: "gcal",
        default_driver: "driver-gcal",
        route_prefix: "/api/gcal",
        description: "Google Calendar event read/apply — used by uebermensch \
                      timeboxes.",
    },
    CapabilityRegistration {
        id: "search.brave",
        default_driver: "driver-brave",
        route_prefix: "/api/search",
        description: "Brave Search API — web/news/images.",
    },
    CapabilityRegistration {
        id: "browser.cdp",
        default_driver: "driver-browser",
        route_prefix: "/api/browser",
        description: "Headless Chromium via Chrome DevTools Protocol — for \
                      paywall-fallback article extraction.",
    },
];

/// Look up a capability by id. Returns `None` if the id is not in the
/// registry — the install protocol uses this for manifest validation.
pub fn lookup(id: &str) -> Option<&'static CapabilityRegistration> {
    REGISTRY.iter().find(|c| c.id == id)
}

/// All known capability ids, in registry order.
pub fn known_ids() -> impl Iterator<Item = &'static str> {
    REGISTRY.iter().map(|c| c.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_every_documented_capability() {
        // The manifest example in app-install-protocol.md declares these caps;
        // the kernel registry MUST know all of them or the example install
        // would fail.
        for id in [
            "llm",
            "deliverer.telegram",
            "deliverer.discord",
            "vault.write",
            "vault.sync",
            "secrets",
            "gcal",
            "search.brave",
            "browser.cdp",
        ] {
            assert!(lookup(id).is_some(), "missing capability id: {id}");
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for cap in REGISTRY {
            assert!(
                seen.insert(cap.id),
                "duplicate capability id: {}",
                cap.id
            );
        }
    }

    #[test]
    fn ids_are_kebab_dotted() {
        for cap in REGISTRY {
            for segment in cap.id.split('.') {
                assert!(!segment.is_empty(), "empty segment in id: {}", cap.id);
                assert!(
                    segment.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                    "non-kebab-case segment `{segment}` in id: {}",
                    cap.id
                );
            }
        }
    }

    #[test]
    fn route_prefixes_start_with_slash() {
        for cap in REGISTRY {
            assert!(cap.route_prefix.starts_with('/'), "{} route_prefix missing leading /", cap.id);
        }
    }

    #[test]
    fn lookup_unknown_returns_none() {
        assert!(lookup("vault.frobnicate").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn known_ids_iterator_matches_registry_order() {
        let ids: Vec<&'static str> = known_ids().collect();
        let direct: Vec<&'static str> = REGISTRY.iter().map(|c| c.id).collect();
        assert_eq!(ids, direct);
    }
}
