// Power capability — prevent host idle sleep via IOKit power assertions.
//
// This is the "caffeinate" capability: the kernel daemon holds an
// `IOPMAssertion` for its whole lifetime by default, so whenever gctrl is
// running the Mac won't idle-sleep (a drop-in replacement for the Caffeine
// menu-bar app). The assertion is released when the daemon process exits;
// the explicit `Drop` below is belt-and-suspenders for graceful teardown.
//
// Per the driver-macos spec this is the only crate allowed to link Apple
// frameworks — IOKit is added in `build.rs` under the `ffi` feature.
//
// Architecture: vault/specs/architecture/kernel/driver-macos.md (`PowerPort`)

use gctrl_core::platform::{PlatformError, PowerPort, PowerStatus, SleepPreventionKind};

/// Default reason string surfaced in `pmset -g assertions`.
pub const DEFAULT_REASON: &str = "gctrl kernel is running";

/// Whether this build links the real IOKit assertion API. `false` on
/// non-macOS / non-FFI builds, where the capability is a no-op stub.
pub const fn is_supported() -> bool {
    cfg!(all(feature = "ffi", target_os = "macos"))
}

/// Build the platform power port for the current build: the real
/// IOKit-backed implementation under `ffi` + macOS, otherwise a no-op stub
/// that reports `supported = false`.
pub fn make_power() -> Box<dyn PowerPort> {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        Box::new(MacPower::new())
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        Box::new(NoopPower)
    }
}

/// Parse the `GCTRL_PREVENT_SLEEP` env var into the desired default state at
/// daemon boot. Returns `None` when prevent-sleep should stay OFF, or
/// `Some(kind)` for the assertion type to hold.
///
/// - unset / `1` / `on` / `true` / `yes` / `display` → `Some(Display)` (default)
/// - `system`                                        → `Some(System)`
/// - `0` / `off` / `false` / `no`                    → `None`
/// - anything else                                   → `Some(Display)`
///
/// The headline default is ON (display-awake) because the whole point of the
/// feature is "whenever gctrl is running, the Mac won't sleep".
pub fn default_from_env(raw: Option<&str>) -> Option<SleepPreventionKind> {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("1") | Some("on") | Some("true") | Some("yes")
        | Some("display") => Some(SleepPreventionKind::Display),
        Some("system") => Some(SleepPreventionKind::System),
        Some("0") | Some("off") | Some("false") | Some("no") => None,
        Some(_) => Some(SleepPreventionKind::Display),
    }
}

// ─────────────────────────────────────────────────────────────────────
// No-op stub (non-FFI / non-macOS builds)
// ─────────────────────────────────────────────────────────────────────

/// Stub power port: advertises `supported = false` and rejects toggles. Used
/// on Linux/Windows and on macOS builds without the `ffi` feature so the
/// route shape stays consistent across targets.
pub struct NoopPower;

impl PowerPort for NoopPower {
    fn status(&self) -> PowerStatus {
        PowerStatus {
            supported: false,
            active: false,
            kind: SleepPreventionKind::default(),
            reason: String::new(),
        }
    }

    fn set_prevent_sleep(
        &self,
        _enable: bool,
        _kind: SleepPreventionKind,
        _reason: &str,
    ) -> Result<PowerStatus, PlatformError> {
        Err(PlatformError::Unsupported {
            what: "power.prevent_sleep (driver-macos ffi feature not enabled)".into(),
        })
    }
}

// ─────────────────────────────────────────────────────────────────────
// IOKit-backed implementation (ffi + macOS)
// ─────────────────────────────────────────────────────────────────────

#[cfg(all(feature = "ffi", target_os = "macos"))]
mod ffi {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    pub type IOPMAssertionID = u32;
    type IOPMAssertionLevel = u32;
    type IOReturn = i32;

    const KIOPM_ASSERTION_LEVEL_ON: IOPMAssertionLevel = 255;
    const KERN_SUCCESS: IOReturn = 0;

    // The two assertion-type CFString constants we use, as their underlying
    // string values (IOKit matches on the string, not the symbol).
    pub const PREVENT_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
    pub const PREVENT_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";

    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: IOPMAssertionLevel,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    /// Create a prevent-sleep assertion of `assertion_type`. Returns the
    /// assertion id on success, or the non-zero `IOReturn` code on failure.
    pub fn create(assertion_type: &str, name: &str) -> Result<IOPMAssertionID, i32> {
        let cf_type = CFString::new(assertion_type);
        let cf_name = CFString::new(name);
        let mut id: IOPMAssertionID = 0;
        // SAFETY: documented public IOKit API. The CFStrings live for the
        // duration of the call (IOKit copies them), and `id` is a valid
        // out-pointer to a stack u32.
        let ret = unsafe {
            IOPMAssertionCreateWithName(
                cf_type.as_concrete_TypeRef(),
                KIOPM_ASSERTION_LEVEL_ON,
                cf_name.as_concrete_TypeRef(),
                &mut id,
            )
        };
        if ret == KERN_SUCCESS {
            Ok(id)
        } else {
            Err(ret)
        }
    }

    /// Release a previously-created assertion.
    pub fn release(id: IOPMAssertionID) -> Result<(), i32> {
        // SAFETY: `id` came from a successful `create` and is released at
        // most once (the caller takes it out of the held slot first).
        let ret = unsafe { IOPMAssertionRelease(id) };
        if ret == KERN_SUCCESS {
            Ok(())
        } else {
            Err(ret)
        }
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
struct Held {
    id: ffi::IOPMAssertionID,
    kind: SleepPreventionKind,
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
struct MacPowerInner {
    held: Option<Held>,
    /// Last-requested kind, so `status()` reports a sensible type even when
    /// no assertion is currently held.
    last_kind: SleepPreventionKind,
    reason: String,
}

/// IOKit-backed power port. Holds at most one assertion at a time behind a
/// mutex so concurrent HTTP toggles can't leak or double-release ids.
#[cfg(all(feature = "ffi", target_os = "macos"))]
pub struct MacPower {
    inner: std::sync::Mutex<MacPowerInner>,
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
impl MacPower {
    fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(MacPowerInner {
                held: None,
                last_kind: SleepPreventionKind::default(),
                reason: DEFAULT_REASON.to_string(),
            }),
        }
    }

    fn assertion_type(kind: SleepPreventionKind) -> &'static str {
        match kind {
            SleepPreventionKind::Display => ffi::PREVENT_DISPLAY_SLEEP,
            SleepPreventionKind::System => ffi::PREVENT_SYSTEM_SLEEP,
        }
    }

    fn snapshot(inner: &MacPowerInner) -> PowerStatus {
        PowerStatus {
            supported: true,
            active: inner.held.is_some(),
            kind: inner.held.as_ref().map(|h| h.kind).unwrap_or(inner.last_kind),
            reason: inner.reason.clone(),
        }
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
impl PowerPort for MacPower {
    fn status(&self) -> PowerStatus {
        let inner = self.inner.lock().unwrap();
        Self::snapshot(&inner)
    }

    fn set_prevent_sleep(
        &self,
        enable: bool,
        kind: SleepPreventionKind,
        reason: &str,
    ) -> Result<PowerStatus, PlatformError> {
        let mut inner = self.inner.lock().unwrap();
        inner.last_kind = kind;
        if !reason.is_empty() {
            inner.reason = reason.to_string();
        }

        // Drop any existing assertion first: toggling off, or switching the
        // assertion type, both require releasing the old id.
        if let Some(held) = inner.held.take() {
            if let Err(code) = ffi::release(held.id) {
                // Re-store so we don't silently leak the id.
                inner.held = Some(held);
                return Err(PlatformError::Underlying(format!(
                    "IOPMAssertionRelease failed (code {code})"
                )));
            }
        }

        if enable {
            let name = inner.reason.clone();
            match ffi::create(Self::assertion_type(kind), &name) {
                Ok(id) => inner.held = Some(Held { id, kind }),
                Err(code) => {
                    return Err(PlatformError::Underlying(format!(
                        "IOPMAssertionCreateWithName failed (code {code})"
                    )))
                }
            }
        }

        Ok(Self::snapshot(&inner))
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
impl Drop for MacPower {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(held) = inner.held.take() {
                let _ = ffi::release(held.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_from_env_defaults_on_display() {
        assert_eq!(default_from_env(None), Some(SleepPreventionKind::Display));
        assert_eq!(default_from_env(Some("")), Some(SleepPreventionKind::Display));
        assert_eq!(default_from_env(Some("1")), Some(SleepPreventionKind::Display));
        assert_eq!(default_from_env(Some("on")), Some(SleepPreventionKind::Display));
        assert_eq!(
            default_from_env(Some("DISPLAY")),
            Some(SleepPreventionKind::Display)
        );
    }

    #[test]
    fn default_from_env_system_kind() {
        assert_eq!(default_from_env(Some("system")), Some(SleepPreventionKind::System));
        assert_eq!(default_from_env(Some(" System ")), Some(SleepPreventionKind::System));
    }

    #[test]
    fn default_from_env_off_values_disable() {
        for v in ["0", "off", "false", "no", "OFF"] {
            assert_eq!(default_from_env(Some(v)), None, "value {v} should disable");
        }
    }

    #[test]
    fn noop_power_reports_unsupported() {
        let p = NoopPower;
        let s = p.status();
        assert!(!s.supported);
        assert!(!s.active);
        assert!(p
            .set_prevent_sleep(true, SleepPreventionKind::Display, "x")
            .is_err());
    }

    // Real IOKit round-trip — only on macOS + ffi. Creates and releases a
    // genuine assertion; the system briefly cannot idle-sleep, then can
    // again. Safe to run unattended.
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    #[test]
    fn mac_power_toggle_round_trip() {
        let p = MacPower::new();
        assert!(!p.status().active);

        let on = p
            .set_prevent_sleep(true, SleepPreventionKind::Display, "gctrl test")
            .expect("enable assertion");
        assert!(on.active);
        assert!(on.supported);
        assert_eq!(on.kind, SleepPreventionKind::Display);
        assert!(p.status().active);

        let off = p
            .set_prevent_sleep(false, SleepPreventionKind::Display, "gctrl test")
            .expect("disable assertion");
        assert!(!off.active);
        assert!(!p.status().active);
    }
}
