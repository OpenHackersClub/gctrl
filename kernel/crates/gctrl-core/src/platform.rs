// Platform driver port — implemented by `gctrl-driver-macos` (and future
// `driver-linux`, `driver-windows`). The kernel mounts a single
// `PlatformPort` per host OS at startup and routes `/api/{os}/*` calls to
// it. See vault/specs/architecture/kernel/driver-macos.md for the rationale
// behind the capability-sub-port split.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Host operating system. Carried in the `PlatformPort::os()` discriminator
/// so consumers can feature-detect off the wire shape rather than the
/// linker layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    MacOS,
    Linux,
    Windows,
    Unknown,
}

/// Capability set advertised by a platform driver. Capabilities are
/// runtime-resolved (depend on user-granted permissions like Accessibility)
/// rather than compile-time, so consumers MUST honor this set instead of
/// assuming a capability exists because the OS matches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapabilitySet {
    pub spaces: bool,
    pub notifications: bool,
    pub login_items: bool,
    pub power: bool,
    pub screen_capture: bool,
}

impl CapabilitySet {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Render as the JSON-friendly array form returned by `/api/{os}/health`
    /// (e.g. `["spaces", "notifications"]`).
    pub fn as_strings(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.spaces {
            out.push("spaces".into());
        }
        if self.notifications {
            out.push("notifications".into());
        }
        if self.login_items {
            out.push("login_items".into());
        }
        if self.power {
            out.push("power".into());
        }
        if self.screen_capture {
            out.push("screen_capture".into());
        }
        out
    }
}

/// Per-permission tri-state for the health response. Mirrors the `granted`
/// / `denied` / `not_requested` strings the spec wires through to the
/// Electron settings panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    Granted,
    Denied,
    NotRequested,
    NotPromptable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PermissionStates {
    pub accessibility: Option<PermissionStatus>,
    pub notifications: Option<PermissionStatus>,
    pub screen_recording: Option<PermissionStatus>,
}

/// Health/discovery payload returned by `/api/{os}/health`. Built by the
/// driver, serialized straight to JSON by the route handler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformHealth {
    pub os: Os,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub permissions: PermissionStates,
    /// Set when a layout-fixture / FFI symbol probe failed; the driver kept
    /// the route alive but excluded the affected capability.
    #[serde(default)]
    pub version_skew: bool,
}

#[derive(Debug, Clone, Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlatformError {
    #[error("permission denied: {what}")]
    PermissionDenied { what: String },

    #[error("unsupported on this platform / version: {what}")]
    Unsupported { what: String },

    #[error("display went away mid-call")]
    DisplayGone,

    #[error("macOS version moved private symbols / layout: {detail}")]
    VersionSkew { detail: String },

    #[error("underlying error: {0}")]
    Underlying(String),
}

/// Stable-within-a-login-session opaque space identifier. Internally a u64
/// CGS id on macOS; consumers MUST treat it as opaque.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SpaceId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceKind {
    User,
    Fullscreen,
    Tiled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: SpaceId,
    pub display_id: u32,
    pub display_uuid: String,
    pub index: u32,
    pub kind: SpaceKind,
    /// gctrl-assigned label, persisted in `macos_space_labels`.
    pub name: Option<String>,
    /// What the OS calls this space ("Desktop 1", "Desktop 2", ...).
    pub system_label: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpaceEvent {
    Switched { id: SpaceId },
    Renamed { id: SpaceId, name: Option<String> },
    Added { id: SpaceId },
    Removed { id: SpaceId },
}

/// Platform-wide port. One implementation is mounted per host OS at kernel
/// boot. Capability sub-ports are returned `Option<&dyn _>` so a driver
/// missing a runtime permission can advertise the capability as absent
/// without panicking.
pub trait PlatformPort: Send + Sync {
    fn os(&self) -> Os;
    fn capabilities(&self) -> CapabilitySet;
    fn health(&self) -> PlatformHealth;
    fn spaces(&self) -> Option<&dyn SpacesPort> {
        None
    }
}

/// Persisted Space-label row matching the `macos_space_labels` schema.
/// Lives in `gctrl-core` so both the storage adapter (`gctrl-storage`)
/// and the driver (`gctrl-driver-macos`) can name the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacosSpaceLabel {
    pub machine_id: String,
    pub display_uuid: String,
    pub space_index: i32,
    pub space_kind: String,
    pub label: String,
    pub cgs_id_hint: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// macOS Mission Control Spaces. The v1 capability surface needed for the
/// headline named-spaces feature.
pub trait SpacesPort: Send + Sync {
    fn list(&self) -> Result<Vec<Space>, PlatformError>;
    fn current(&self) -> Result<Space, PlatformError>;
    fn name(&self, space_id: SpaceId, name: &str) -> Result<(), PlatformError>;
    fn unname(&self, space_id: SpaceId) -> Result<(), PlatformError>;
    fn switch_to(&self, space_id: SpaceId) -> Result<(), PlatformError>;
}
