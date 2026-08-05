// gctrl-driver-macos — macOS platform driver (LKM).
//
// Default build is a no-op stub: `PlatformPort::os()` returns `Os::MacOS`
// when compiled on a Mac, and `capabilities()` returns the empty set so
// consumers feature-detect `spaces` as absent. The real renderer lives
// behind the `ffi` Cargo feature (gated by `gctrl-cli`'s
// `macos-platform`); on that path `default_driver()` returns an
// `FfiDriver` that wires the CGS reader, AX overlay, and storage.
//
// Architecture: vault/specs/architecture/kernel/driver-macos.md
// Implementation: vault/specs/implementation/kernel/driver-macos.md

use std::sync::Arc;

use gctrl_core::platform::{
    CapabilitySet, Os, PermissionStates, PermissionStatus, PlatformError, PlatformHealth,
    PlatformPort, PowerPort, Space, SpaceId, SpaceKind, SpacesPort,
};
use gctrl_storage::DuckDbStore;

pub mod permissions;
pub mod power;
pub mod routes;
pub mod spaces;

#[cfg(all(feature = "ffi", target_os = "macos"))]
mod app_loop;

/// Hand the OS main thread to AppKit's `NSApplication.run()`. Required
/// for the macOS Spaces overlay (NSWindow is `MainThreadOnly`). Blocks
/// until `[NSApp terminate:]` is posted; on non-FFI / non-macOS builds
/// it parks the thread on a sleep so the kernel daemon stays alive
/// while the tokio runtime worker drives the rest of the kernel.
pub fn run_main_app_loop() {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        app_loop::run();
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        // No AppKit needed; park forever. Process exit comes from
        // SIGINT/SIGTERM hitting both this thread and the tokio worker.
        loop {
            std::thread::park();
        }
    }
}

/// Stub driver. Compiles on every target so the workspace stays
/// cross-OS portable. Capabilities advertise empty regardless of the
/// `ffi` feature — consumers must feature-detect via /api/macos/health
/// before relying on any capability sub-port.
pub struct StubDriver;

impl StubDriver {
    pub const fn new() -> Self {
        Self
    }
}

impl Default for StubDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformPort for StubDriver {
    fn os(&self) -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOS
        } else {
            Os::Unknown
        }
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::empty()
    }

    fn health(&self) -> PlatformHealth {
        PlatformHealth {
            os: self.os(),
            version: macos_version(),
            capabilities: self.capabilities().as_strings(),
            permissions: PermissionStates {
                accessibility: Some(permissions::ax_status()),
                notifications: None,
                screen_recording: None,
            },
            version_skew: false,
        }
    }

    fn spaces(&self) -> Option<&dyn SpacesPort> {
        None
    }
}

/// FFI-backed driver. Holds a `SpacesState` (storage handle + event
/// bus + overlay) and the `SpacesPort` impl produced by
/// `spaces::make_port`. `capabilities.spaces` is true iff AX trust is
/// granted *and* the port construction succeeded; otherwise it falls
/// back to the storage-only port and reports `spaces=false` so the
/// settings panel shows the permission CTA.
pub struct FfiDriver {
    state: Arc<spaces::SpacesState>,
    port: Option<Box<dyn SpacesPort>>,
    spaces_capable: bool,
    version_skew: bool,
    power: Box<dyn PowerPort>,
    power_capable: bool,
}

impl FfiDriver {
    pub fn new(store: Arc<DuckDbStore>) -> Self {
        let state = Arc::new(spaces::SpacesState::new(store));
        let port = spaces::make_port(state.clone());
        let ax_ok = matches!(permissions::ax_status(), PermissionStatus::Granted);
        // `spaces` capability only when we have a port AND AX trust.
        // The storage-only port still works (label persistence, list)
        // but we don't advertise the capability without the renderer.
        let spaces_capable = ax_ok && port.is_some();

        // Power (prevent-sleep / "caffeinate") capability. Default-on: hold a
        // prevent-sleep assertion for the daemon's whole lifetime unless
        // GCTRL_PREVENT_SLEEP disables it — "whenever gctrl is running, the
        // Mac won't sleep". The OS releases the assertion when the process
        // exits; `MacPower`'s Drop is belt-and-suspenders for graceful stop.
        let power = power::make_power();
        let power_capable = power::is_supported();
        if power_capable {
            match power::default_from_env(
                std::env::var("GCTRL_PREVENT_SLEEP").ok().as_deref(),
            ) {
                Some(kind) => {
                    match power.set_prevent_sleep(true, kind, power::DEFAULT_REASON) {
                        Ok(s) => tracing::info!(
                            kind = ?s.kind,
                            "driver-macos: prevent-sleep ON (Mac will not idle-sleep while gctrl runs)"
                        ),
                        Err(e) => tracing::warn!(
                            "driver-macos: prevent-sleep default-on failed: {e}"
                        ),
                    }
                }
                None => tracing::info!(
                    "driver-macos: prevent-sleep disabled via GCTRL_PREVENT_SLEEP"
                ),
            }
        }

        Self {
            state,
            port,
            spaces_capable,
            version_skew: false,
            power,
            power_capable,
        }
    }

    pub fn state(&self) -> &Arc<spaces::SpacesState> {
        &self.state
    }
}

impl PlatformPort for FfiDriver {
    fn os(&self) -> Os {
        Os::MacOS
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet {
            spaces: self.spaces_capable,
            power: self.power_capable,
            ..Default::default()
        }
    }
    fn health(&self) -> PlatformHealth {
        PlatformHealth {
            os: self.os(),
            version: macos_version(),
            capabilities: self.capabilities().as_strings(),
            permissions: PermissionStates {
                accessibility: Some(permissions::ax_status()),
                notifications: None,
                screen_recording: None,
            },
            version_skew: self.version_skew,
        }
    }
    fn spaces(&self) -> Option<&dyn SpacesPort> {
        self.port.as_deref()
    }
    fn power(&self) -> Option<&dyn PowerPort> {
        Some(self.power.as_ref())
    }
}

#[cfg(target_os = "macos")]
fn macos_version() -> Option<String> {
    use std::process::Command;
    let out = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn macos_version() -> Option<String> {
    None
}

/// Build the default driver implementation for the current build.
///
/// - `ffi` + macOS: returns an `FfiDriver` that, given a storage
///   handle later via `with_store`, renders labels through the AX
///   overlay. Currently the kernel constructs the driver before
///   storage is wired; for this PR we keep the entry point store-less
///   and the routes module composes a `StubDriver`. The store-aware
///   `default_driver_with_store` factory is what `gctrl-cli` should
///   call once it's threading the store down to driver registration.
///
/// - default build: returns `StubDriver`.
pub fn default_driver() -> Box<dyn PlatformPort> {
    Box::new(StubDriver::new())
}

/// Store-aware factory. The kernel binary should prefer this once it
/// has a `DuckDbStore` to hand the driver. Falls back to the stub on
/// non-FFI builds so the call site stays single-shape.
pub fn default_driver_with_store(_store: Arc<DuckDbStore>) -> Box<dyn PlatformPort> {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        return Box::new(FfiDriver::new(_store));
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        Box::new(StubDriver::new())
    }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers shared between routes & the FFI overlay path.
// ─────────────────────────────────────────────────────────────────────

/// Until live CGS enumeration is the sole path, the routes module maps
/// a `SpaceId` 1:1 to its `space_index`. The `FfiDriver` resolves the
/// real CGS id via the `id` module.
pub(crate) fn space_id_to_index(id: SpaceId) -> i32 {
    id.0 as i32
}

pub(crate) const PLACEHOLDER_SPACE_KIND: &str = "user";

/// `machine_id` for stored labels. The spec calls for a `node_identity`
/// row to back this; until that table lands we derive a stable id from
/// the host's hostname so labels survive reboot. The function is
/// `pub(crate)` so the `spaces` module shares the same value.
pub(crate) fn machine_id() -> String {
    #[cfg(unix)]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("/bin/hostname").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    "local".into()
}

/// Primary display UUID. Real implementation reads
/// `CGDisplayCreateUUIDFromDisplayID(CGMainDisplayID())`; the stub
/// returns a stable string so the schema's PRIMARY KEY constraint is
/// happy on Linux developer builds and pre-FFI macOS.
#[cfg(all(feature = "ffi", target_os = "macos"))]
pub(crate) fn primary_display_uuid() -> String {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation::uuid::CFUUID;

    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateUUIDFromDisplayID(
            display: u32,
        ) -> *const std::ffi::c_void;
    }
    // SAFETY: documented public CGDisplay API; CGDisplayCreate*
    // returns +1 retain, wrapped under create rule.
    unsafe {
        let id = CGMainDisplayID();
        let raw = CGDisplayCreateUUIDFromDisplayID(id);
        if raw.is_null() {
            return "primary".into();
        }
        let uuid: CFUUID = CFUUID::wrap_under_create_rule(raw as _);
        let s: CFString = CFString::wrap_under_create_rule(
            core_foundation::uuid::CFUUIDCreateString(std::ptr::null(), uuid.as_concrete_TypeRef())
                as _,
        );
        s.to_string()
    }
}

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
pub(crate) fn primary_display_uuid() -> String {
    "primary".into()
}

#[allow(dead_code)]
pub(crate) fn unsupported(what: &str) -> PlatformError {
    PlatformError::Unsupported {
        what: what.to_string(),
    }
}

/// Build a `Space` from a stored label row using the stop-gap index <-> id
/// mapping. Used by `/api/macos/spaces` when the `ffi` feature is off.
pub fn stub_space_for_label(
    label: &gctrl_core::MacosSpaceLabel,
    is_current: bool,
) -> Space {
    let kind = match label.space_kind.as_str() {
        "fullscreen" => SpaceKind::Fullscreen,
        "tiled" => SpaceKind::Tiled,
        _ => SpaceKind::User,
    };
    Space {
        id: SpaceId(label.space_index as u64),
        display_id: 0,
        display_uuid: label.display_uuid.clone(),
        index: label.space_index as u32,
        kind,
        name: Some(label.label.clone()),
        system_label: format!("Desktop {}", label.space_index),
        is_current,
    }
}

/// Storage handle exposed for the routes module. Kept on its own type so
/// the trait stays focused on capability semantics rather than IO.
pub type StoreHandle = Option<Arc<DuckDbStore>>;
