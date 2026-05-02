// Accessibility permission probe.
//
// Default-feature build is a stub that always reports `NotRequested` —
// safe on every target (including Linux developer builds). The real FFI
// (AXIsProcessTrustedWithOptions) is wired behind the `ffi` Cargo feature
// in a follow-up commit; that switch is the only place the public AppKit
// linkage gets pulled into the kernel binary.

use gctrl_core::platform::PermissionStatus;

/// Probe AX trust without prompting. Stub returns `NotRequested` so the
/// /api/macos/health response shape is realistic on all platforms.
pub fn ax_status() -> PermissionStatus {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        ffi_macos::ax_status()
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        PermissionStatus::NotRequested
    }
}

/// Trigger the AX prompt. On the stub this is a no-op.
pub fn prompt_ax() -> PermissionStatus {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        ffi_macos::prompt_ax()
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        PermissionStatus::NotRequested
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
mod ffi_macos {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use gctrl_core::platform::PermissionStatus;

    // ApplicationServices/HIServices exports. The `options` dict is
    // optional — pass null for a non-prompting probe, or pass a
    // dictionary keyed on `kAXTrustedCheckOptionPrompt` (the framework
    // global) with value `true` to surface the system prompt.
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /// Probe AX trust without prompting.
    pub fn ax_status() -> PermissionStatus {
        // SAFETY: passing a null options dictionary is documented as
        // "no prompt"; the function is a pure trust probe with no side
        // effects beyond reading the TCC state.
        let trusted = unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) };
        if trusted {
            PermissionStatus::Granted
        } else {
            PermissionStatus::Denied
        }
    }

    /// Trigger the system AX prompt. The first call after a TCC reset
    /// surfaces the dialog; subsequent calls return the current state
    /// without re-prompting.
    pub fn prompt_ax() -> PermissionStatus {
        // SAFETY: `kAXTrustedCheckOptionPrompt` is a framework constant
        // with static lifetime; wrap_under_get_rule retains it.
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let val = CFBoolean::true_value();
        let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
        // SAFETY: dict outlives the call; CFDictionaryRef is borrowed.
        let trusted = unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) };
        if trusted {
            PermissionStatus::Granted
        } else {
            PermissionStatus::Denied
        }
    }
}
