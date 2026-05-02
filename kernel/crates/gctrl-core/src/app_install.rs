//! Persistent shape of an app install record.
//!
//! `AppManifest` (in `app_manifest.rs`) is the *input* — what the operator
//! authored in `gctrl-app.toml`. `AppInstall` + `AppBinding` are the *output*
//! — what the kernel records in `gctrl_app_installs` / `gctrl_app_bindings`
//! after a successful `gctrl app install`. They're the persisted projection
//! of the manifest plus install-time metadata (source ref, manifest sha,
//! resolved driver per capability).
//!
//! See `vault/specs/architecture/app-install-protocol.md` § Storage for the
//! authoritative schema.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One row of `gctrl_app_installs` — the kernel's record that this app is
/// installed on this machine. Capability bindings live in `gctrl_app_bindings`
/// (one row per capability, joined by `name`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppInstall {
    /// Matches the manifest `[app] name`. Globally unique within a kernel —
    /// only one install per app name is supported (v1).
    pub name: String,

    /// Manifest `[app] version`. Operator can bump and `gctrl app reload`.
    pub version: String,

    /// Where the manifest came from — local filesystem path or git URL.
    /// Informational; supports `gctrl app reload` re-fetching.
    pub source_ref: String,

    /// SHA-256 of the raw `gctrl-app.toml` text at install time. Lets
    /// `gctrl app status` flag drift between the on-disk manifest and the
    /// last-installed version.
    pub manifest_sha: String,

    pub installed_at: DateTime<Utc>,

    /// Set when `gctrl app reload <name>` re-applies the manifest. Null
    /// until the first reload.
    pub reloaded_at: Option<DateTime<Utc>>,
}

/// One row of `gctrl_app_bindings` — records that an installed app uses a
/// specific kernel-registry capability + which driver fulfills it. `driver_id`
/// is denormalized from the capability registry at install time so a future
/// kernel registry change does not silently rewrite history; `gctrl app
/// reload` re-resolves to pick up changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppBinding {
    /// FK → `gctrl_app_installs.name`.
    pub install_name: String,

    /// Capability id from the kernel registry (e.g. `"llm"`, `"deliverer.telegram"`).
    /// Together with `install_name` forms the row's PK.
    pub capability: String,

    /// Resolved kernel driver id (from `crate::capabilities::REGISTRY` at
    /// install time). e.g. `"driver-llm"`, `"driver-telegram"`.
    pub driver_id: String,

    /// `true` for `[requires.*]`, `false` for `[optional.*]`.
    pub required: bool,

    pub resolved_at: DateTime<Utc>,
}
