//! `gctrl-app.toml` parser + validator.
//!
//! Reads an app's manifest into a typed `AppManifest`, validates that every
//! declared capability id exists in the kernel registry (`crate::capabilities`),
//! and enforces the project-key rules from
//! `vault/specs/architecture/app-install-protocol.md` § Schema rules.
//!
//! Pure data — no I/O beyond `std::fs::read_to_string`. The install machinery
//! (PR-α.2 / PR-α.3) takes the validated manifest and persists it.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use thiserror::Error;

use crate::capabilities;

// ───────────────────────── Manifest types ─────────────────────────

/// Parsed `gctrl-app.toml`. Field shapes mirror the spec example in
/// `vault/specs/architecture/app-install-protocol.md`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppManifest {
    pub app: AppMeta,
    pub entrypoint: Entrypoint,

    /// Required capabilities (manifest table `[requires.<id>]`). The
    /// installer rejects the manifest if any id is unknown to the registry.
    /// Stored as an ordered map so manifest order is preserved for
    /// deterministic installer output.
    #[serde(default, rename = "requires")]
    pub requires: BTreeMap<String, CapabilitySpec>,

    /// Optional capabilities (`[optional.<id>]`). Same validation; the app's
    /// code MUST gracefully degrade when one is unavailable on this host.
    #[serde(default, rename = "optional")]
    pub optional: BTreeMap<String, CapabilitySpec>,

    /// Vault project keys this app claims under the kernel-owned vault root
    /// (per PR #163). At install time, each is registered into
    /// `gctrl_vault_mounts` with the app as owner.
    #[serde(default, rename = "vault-projects")]
    pub vault_projects: Vec<VaultProject>,

    /// Cron schedules the kernel registers on the app's behalf.
    #[serde(default)]
    pub schedule: Vec<Schedule>,

    /// Secrets the app reads via `SecretsService.get`. Informational — the
    /// kernel uses this for the onboarding wizard's UX, not for enforcement.
    #[serde(default, rename = "secrets")]
    pub secrets: Vec<SecretDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppMeta {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entrypoint {
    pub bin: String,
    pub command: String,
    pub runtime: String,
}

/// `[requires.llm]` body. Today only `description` is meaningful; future
/// versions may add per-capability config (e.g. effort tier defaults).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CapabilitySpec {
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultProject {
    /// Uppercase, globally unique within the kernel's vault root.
    pub key: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Schedule {
    pub name: String,
    pub cron: String,
    /// One of `"exec"` | `"http"`. Mirrors the kernel scheduler's `target_kind`.
    pub target: String,
    /// For `target = "exec"`: command argv. For `target = "http"`: URL parts
    /// arrive in additional fields not modeled here yet.
    #[serde(default)]
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretDecl {
    pub key: String,
    /// One of `"string"` | `"url"` | `"token"` — UX hint only.
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
}

// ───────────────────────── Errors ─────────────────────────

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("toml parse failed: {0}")]
    Parse(String),

    #[error("io error reading manifest at {path}: {cause}")]
    Io { path: String, cause: String },

    #[error("unknown capability id `{id}` in [{section}.] — not in kernel capability registry")]
    UnknownCapability { id: String, section: String },

    #[error("capability id `{id}` declared in both [requires.] and [optional.]")]
    DuplicateCapability { id: String },

    #[error("project key `{key}` is not uppercase / kebab+digits — must match /^[A-Z][A-Z0-9-]*$/")]
    InvalidProjectKey { key: String },

    #[error("project key `{key}` declared more than once")]
    DuplicateProjectKey { key: String },

    #[error("schedule name `{name}` declared more than once")]
    DuplicateSchedule { name: String },

    #[error("secret key `{key}` declared more than once")]
    DuplicateSecret { key: String },

    #[error("[app] name `{name}` is not kebab-case (/^[a-z][a-z0-9-]*[a-z0-9]$/)")]
    InvalidAppName { name: String },

    #[error("[entrypoint] runtime `{runtime}` is not one of: node | bun | deno | binary")]
    InvalidRuntime { runtime: String },

    #[error("schedule `{name}` target `{target}` is not one of: exec | http")]
    InvalidScheduleTarget { name: String, target: String },

    #[error("secret `{key}` kind `{kind}` is not one of: string | url | token")]
    InvalidSecretKind { key: String, kind: String },
}

// ───────────────────────── API ─────────────────────────

impl AppManifest {
    /// Load + validate a manifest from disk.
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        let text = std::fs::read_to_string(path).map_err(|e| ManifestError::Io {
            path: path.display().to_string(),
            cause: e.to_string(),
        })?;
        Self::parse(&text)
    }

    /// Parse + validate from an in-memory string. Used by tests + the future
    /// `/api/app/install` route which may receive manifest text inline.
    pub fn parse(text: &str) -> Result<Self, ManifestError> {
        // Two-phase parse:
        // 1. Pull `requires` / `optional` out as raw TOML tables and flatten
        //    nested keys (`[requires.deliverer.telegram]` → `"deliverer.telegram"`).
        //    TOML's nested-table syntax is the natural way to write dotted ids
        //    without quoting; we rebuild the flat capability id post-parse.
        // 2. Strongly-type the rest.
        let mut root: toml::Table =
            toml::from_str(text).map_err(|e| ManifestError::Parse(e.to_string()))?;

        let requires = take_capability_section(&mut root, "requires")?;
        let optional = take_capability_section(&mut root, "optional")?;

        // Re-serialize the remainder so serde can deserialize the typed shape
        // for app / entrypoint / vault-projects / schedule / secrets.
        let remainder = toml::to_string(&root).map_err(|e| ManifestError::Parse(e.to_string()))?;

        #[derive(Deserialize)]
        struct Skeleton {
            app: AppMeta,
            entrypoint: Entrypoint,
            #[serde(default, rename = "vault-projects")]
            vault_projects: Vec<VaultProject>,
            #[serde(default)]
            schedule: Vec<Schedule>,
            #[serde(default)]
            secrets: Vec<SecretDecl>,
        }
        let skel: Skeleton =
            toml::from_str(&remainder).map_err(|e| ManifestError::Parse(e.to_string()))?;

        let manifest = AppManifest {
            app: skel.app,
            entrypoint: skel.entrypoint,
            requires,
            optional,
            vault_projects: skel.vault_projects,
            schedule: skel.schedule,
            secrets: skel.secrets,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    /// Run every cross-field validation rule. Idempotent.
    pub fn validate(&self) -> Result<(), ManifestError> {
        validate_app_name(&self.app.name)?;
        validate_runtime(&self.entrypoint.runtime)?;

        for id in self.requires.keys() {
            if capabilities::lookup(id).is_none() {
                return Err(ManifestError::UnknownCapability {
                    id: id.clone(),
                    section: "requires".into(),
                });
            }
        }
        for id in self.optional.keys() {
            if capabilities::lookup(id).is_none() {
                return Err(ManifestError::UnknownCapability {
                    id: id.clone(),
                    section: "optional".into(),
                });
            }
            if self.requires.contains_key(id) {
                return Err(ManifestError::DuplicateCapability { id: id.clone() });
            }
        }

        let mut seen_keys = HashSet::new();
        for vp in &self.vault_projects {
            validate_project_key(&vp.key)?;
            if !seen_keys.insert(vp.key.clone()) {
                return Err(ManifestError::DuplicateProjectKey { key: vp.key.clone() });
            }
        }

        let mut seen_schedules = HashSet::new();
        for s in &self.schedule {
            if !seen_schedules.insert(s.name.clone()) {
                return Err(ManifestError::DuplicateSchedule { name: s.name.clone() });
            }
            if s.target != "exec" && s.target != "http" {
                return Err(ManifestError::InvalidScheduleTarget {
                    name: s.name.clone(),
                    target: s.target.clone(),
                });
            }
        }

        let mut seen_secrets = HashSet::new();
        for sec in &self.secrets {
            if !seen_secrets.insert(sec.key.clone()) {
                return Err(ManifestError::DuplicateSecret { key: sec.key.clone() });
            }
            if !matches!(sec.kind.as_str(), "string" | "url" | "token") {
                return Err(ManifestError::InvalidSecretKind {
                    key: sec.key.clone(),
                    kind: sec.kind.clone(),
                });
            }
        }

        Ok(())
    }

    /// All capability ids the manifest declares (required + optional), in
    /// stable order — required first (alphabetical), then optional.
    pub fn all_capabilities(&self) -> impl Iterator<Item = (&str, bool)> {
        self.requires
            .keys()
            .map(|id| (id.as_str(), true))
            .chain(self.optional.keys().map(|id| (id.as_str(), false)))
    }
}

/// Walk a TOML table tree under `[requires]` / `[optional]` and flatten dotted
/// nested tables into a flat `BTreeMap<String, CapabilitySpec>` keyed by the
/// dotted path. A "leaf" is a table whose values are all scalars / arrays /
/// inline tables — i.e. the body of a `[requires.deliverer.telegram]` block.
fn take_capability_section(
    root: &mut toml::Table,
    section: &'static str,
) -> Result<BTreeMap<String, CapabilitySpec>, ManifestError> {
    let raw = match root.remove(section) {
        Some(toml::Value::Table(t)) => t,
        Some(_) => {
            return Err(ManifestError::Parse(format!(
                "[{section}] must be a table"
            )))
        }
        None => return Ok(BTreeMap::new()),
    };
    let mut out = BTreeMap::new();
    flatten_capability_table(&raw, String::new(), &mut out, section)?;
    Ok(out)
}

fn flatten_capability_table(
    table: &toml::Table,
    prefix: String,
    out: &mut BTreeMap<String, CapabilitySpec>,
    section: &'static str,
) -> Result<(), ManifestError> {
    // A table is a "capability spec leaf" iff every value is a scalar,
    // array, or inline-table that doesn't itself look like another nested
    // capability (no further sub-tables of strings). The simple rule we use:
    // if any value is itself a `Table`, this node is *not* a leaf — we
    // recurse. Otherwise we treat the whole thing as the CapabilitySpec body.
    let has_subtable = table.values().any(|v| matches!(v, toml::Value::Table(_)));

    if !has_subtable {
        // Leaf: deserialize the body as CapabilitySpec.
        if prefix.is_empty() {
            // Empty prefix means [requires] itself was a leaf with no
            // children — that's a manifest with no capabilities, which is
            // legal but yields no entries.
            return Ok(());
        }
        let spec_value = toml::Value::Table(table.clone());
        let spec: CapabilitySpec = spec_value
            .try_into()
            .map_err(|e: toml::de::Error| ManifestError::Parse(format!(
                "[{section}.{prefix}] body invalid: {e}"
            )))?;
        out.insert(prefix, spec);
        return Ok(());
    }

    for (key, value) in table.iter() {
        match value {
            toml::Value::Table(sub) => {
                let next_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_capability_table(sub, next_prefix, out, section)?;
            }
            // Mixed: sibling scalar fields at this level mean THIS node has
            // both children and CapabilitySpec-shape data — disallowed (would
            // mean both "deliverer is itself a capability" and "deliverer.X
            // is a capability").
            other => {
                return Err(ManifestError::Parse(format!(
                    "[{section}.{prefix}] mixes a sub-capability with a sibling \
                     scalar `{key} = {other}` — pick one shape"
                )));
            }
        }
    }
    Ok(())
}

fn validate_app_name(name: &str) -> Result<(), ManifestError> {
    let invalid = || ManifestError::InvalidAppName {
        name: name.to_string(),
    };
    if name.is_empty() {
        return Err(invalid());
    }
    let bytes = name.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return Err(invalid());
    }
    let last = bytes[bytes.len() - 1];
    if !(last.is_ascii_lowercase() || last.is_ascii_digit()) {
        return Err(invalid());
    }
    for &b in bytes {
        let c = b as char;
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_runtime(runtime: &str) -> Result<(), ManifestError> {
    if matches!(runtime, "node" | "bun" | "deno" | "binary") {
        Ok(())
    } else {
        Err(ManifestError::InvalidRuntime {
            runtime: runtime.to_string(),
        })
    }
}

fn validate_project_key(key: &str) -> Result<(), ManifestError> {
    let bad = || ManifestError::InvalidProjectKey { key: key.to_string() };
    if key.is_empty() {
        return Err(bad());
    }
    let bytes = key.as_bytes();
    if !bytes[0].is_ascii_uppercase() {
        return Err(bad());
    }
    for &b in bytes {
        let c = b as char;
        if !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-') {
            return Err(bad());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_manifest() -> &'static str {
        r#"
[app]
name = "uebermensch"
version = "0.2.0"

[entrypoint]
bin = "dist/main.js"
command = "uber"
runtime = "node"
"#
    }

    fn full_uebermensch_manifest() -> &'static str {
        r#"
[app]
name = "uebermensch"
version = "0.2.0"
description = "Personal Chief of Staff for investors."
homepage = "https://github.com/OpenHackersClub/uebermensch"
license = "MIT"

[entrypoint]
bin = "dist/main.js"
command = "uber"
runtime = "node"

[requires.llm]
description = "Curator + summary lanes."

[requires.deliverer.telegram]
[requires.deliverer.discord]
[requires.vault.write]
[requires.vault.sync]
[requires.secrets]

[optional.gcal]
description = "Calendar event apply for timeboxes."

[optional."search.brave"]
[optional."browser.cdp"]

[[vault-projects]]
key = "UBER"
description = "Uebermensch namespace"

[[schedule]]
name = "uber-daily-brief"
cron = "0 8 * * *"
target = "exec"
command = ["uber", "run-daily"]

[[schedule]]
name = "uber-weekly-report"
cron = "0 9 * * 1"
target = "exec"
command = ["uber", "report", "--send"]

[[secrets]]
key = "ANTHROPIC_API_KEY"
kind = "token"
required = false
description = "Anthropic API key."

[[secrets]]
key = "TELEGRAM_BOT_TOKEN"
kind = "token"
"#
    }

    #[test]
    fn parses_minimal_manifest() {
        let m = AppManifest::parse(minimal_manifest()).expect("parse");
        assert_eq!(m.app.name, "uebermensch");
        assert_eq!(m.app.version, "0.2.0");
        assert_eq!(m.entrypoint.runtime, "node");
        assert!(m.requires.is_empty());
        assert!(m.optional.is_empty());
        assert!(m.vault_projects.is_empty());
        assert!(m.schedule.is_empty());
        assert!(m.secrets.is_empty());
    }

    #[test]
    fn parses_full_uebermensch_manifest() {
        let m = AppManifest::parse(full_uebermensch_manifest()).expect("parse");
        assert_eq!(m.app.name, "uebermensch");
        // Required: llm, deliverer.telegram, deliverer.discord, vault.write, vault.sync, secrets
        assert_eq!(m.requires.len(), 6);
        assert!(m.requires.contains_key("llm"));
        assert!(m.requires.contains_key("deliverer.telegram"));
        // Optional: gcal, search.brave, browser.cdp
        assert_eq!(m.optional.len(), 3);
        assert!(m.optional.contains_key("gcal"));
        assert!(m.optional.contains_key("search.brave"));
        assert_eq!(m.vault_projects.len(), 1);
        assert_eq!(m.vault_projects[0].key, "UBER");
        assert_eq!(m.schedule.len(), 2);
        assert_eq!(m.secrets.len(), 2);
    }

    #[test]
    fn unknown_capability_in_requires_rejected() {
        let manifest = format!(
            "{}\n[requires.vault.frobnicate]\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(
            matches!(err, ManifestError::UnknownCapability { ref id, .. } if id == "vault.frobnicate"),
            "got: {err:?}"
        );
    }

    #[test]
    fn unknown_capability_in_optional_rejected() {
        let manifest = format!(
            "{}\n[optional.search.frobnicate]\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(
            matches!(err, ManifestError::UnknownCapability { ref section, .. } if section == "optional"),
            "got: {err:?}"
        );
    }

    #[test]
    fn capability_in_both_requires_and_optional_rejected() {
        let manifest = format!(
            "{}\n[requires.llm]\n[optional.llm]\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(
            matches!(err, ManifestError::DuplicateCapability { ref id } if id == "llm"),
            "got: {err:?}"
        );
    }

    #[test]
    fn lowercase_project_key_rejected() {
        let manifest = format!(
            "{}\n[[vault-projects]]\nkey = \"uber\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(
            matches!(err, ManifestError::InvalidProjectKey { ref key } if key == "uber"),
            "got: {err:?}"
        );
    }

    #[test]
    fn project_key_with_underscore_rejected() {
        let manifest = format!(
            "{}\n[[vault-projects]]\nkey = \"UBER_NOTES\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::InvalidProjectKey { .. }));
    }

    #[test]
    fn duplicate_project_keys_rejected() {
        let manifest = format!(
            "{}\n[[vault-projects]]\nkey = \"UBER\"\n[[vault-projects]]\nkey = \"UBER\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::DuplicateProjectKey { .. }));
    }

    #[test]
    fn invalid_app_name_rejected() {
        for bad_name in ["UeberMensch", "ueber_mensch", "1uber", "uber-", "ueber!", ""] {
            let manifest = format!(
                "[app]\nname = \"{bad_name}\"\nversion = \"0.1.0\"\n\n\
                [entrypoint]\nbin = \"x\"\ncommand = \"x\"\nruntime = \"node\"\n"
            );
            let err = AppManifest::parse(&manifest).unwrap_err();
            assert!(
                matches!(err, ManifestError::InvalidAppName { .. } | ManifestError::Parse(_)),
                "name={bad_name:?} got: {err:?}"
            );
        }
    }

    #[test]
    fn invalid_runtime_rejected() {
        let manifest = "[app]\nname = \"x\"\nversion = \"0.1.0\"\n\n\
                        [entrypoint]\nbin = \"x\"\ncommand = \"x\"\nruntime = \"python\"\n";
        let err = AppManifest::parse(manifest).unwrap_err();
        assert!(matches!(err, ManifestError::InvalidRuntime { .. }));
    }

    #[test]
    fn duplicate_schedule_name_rejected() {
        let manifest = format!(
            "{}\n\
            [[schedule]]\nname = \"foo\"\ncron = \"* * * * *\"\ntarget = \"exec\"\n\
            [[schedule]]\nname = \"foo\"\ncron = \"0 0 * * *\"\ntarget = \"exec\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::DuplicateSchedule { .. }));
    }

    #[test]
    fn invalid_schedule_target_rejected() {
        let manifest = format!(
            "{}\n[[schedule]]\nname = \"foo\"\ncron = \"* * * * *\"\ntarget = \"smtp\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::InvalidScheduleTarget { .. }));
    }

    #[test]
    fn invalid_secret_kind_rejected() {
        let manifest = format!(
            "{}\n[[secrets]]\nkey = \"X\"\nkind = \"binary\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::InvalidSecretKind { .. }));
    }

    #[test]
    fn duplicate_secret_key_rejected() {
        let manifest = format!(
            "{}\n[[secrets]]\nkey = \"X\"\nkind = \"token\"\n[[secrets]]\nkey = \"X\"\nkind = \"token\"\n",
            minimal_manifest()
        );
        let err = AppManifest::parse(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::DuplicateSecret { .. }));
    }

    #[test]
    fn malformed_toml_rejected() {
        let err = AppManifest::parse("this is not toml [[[").unwrap_err();
        assert!(matches!(err, ManifestError::Parse(_)));
    }

    #[test]
    fn all_capabilities_iterates_required_then_optional() {
        let m = AppManifest::parse(full_uebermensch_manifest()).unwrap();
        let caps: Vec<(&str, bool)> = m.all_capabilities().collect();
        // First 6 are required (BTreeMap → alphabetical); last 3 are optional.
        let required_count = caps.iter().filter(|(_, req)| *req).count();
        let optional_count = caps.iter().filter(|(_, req)| !*req).count();
        assert_eq!(required_count, 6);
        assert_eq!(optional_count, 3);
        let first_required_idx = caps.iter().position(|(_, req)| *req).unwrap();
        let first_optional_idx = caps.iter().position(|(_, req)| !*req).unwrap();
        assert!(first_required_idx < first_optional_idx);
    }

    #[test]
    fn load_from_disk_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gctrl-app.toml");
        std::fs::write(&path, full_uebermensch_manifest()).unwrap();
        let m = AppManifest::load(&path).expect("load");
        assert_eq!(m.app.name, "uebermensch");
    }

    #[test]
    fn load_from_disk_missing_file_returns_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.toml");
        let err = AppManifest::load(&path).unwrap_err();
        assert!(matches!(err, ManifestError::Io { .. }));
    }
}
