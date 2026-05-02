// Mission Control activation detector.
//
// The architecture spec (vault/specs/architecture/kernel/driver-macos.md
// §AX Overlay) calls for an AXObserver on the Dock listening for
// `kAXFocusedUIElementChangedNotification`, with the caveat that
// "private notifications are unreliable across versions; we
// approximate by watching for the Dock's 'expose-frontmost' UI
// element appearing".
//
// The pragmatic v1 implementation polls `CGWindowListCopyWindowInfo`
// at 100ms cadence. CGWindowList is a public, thread-safe read-only
// API, so the detector can run on a tokio worker thread instead of
// requiring CFRunLoop integration. When a Dock-owned window whose
// `kCGWindowName` is "Mission Control" appears, MC is active; when
// it disappears, MC has dismissed.
//
// On non-FFI builds this collapses to a no-op so the spawn site
// stays single-shape.

use std::sync::Arc;
use std::time::Duration;

use crate::spaces::overlay::Overlay;

/// Spawn the MC activation detector. Toggles `overlay.show()` /
/// `overlay.hide()` on transitions. Returns immediately; the detector
/// runs forever on the tokio runtime until the daemon exits.
pub fn spawn(overlay: Arc<Overlay>) {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        tokio::spawn(run(overlay));
    }
    #[cfg(not(all(feature = "ffi", target_os = "macos")))]
    {
        let _ = overlay;
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
async fn run(overlay: Arc<Overlay>) {
    let mut last_active = false;
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    loop {
        interval.tick().await;
        let active = mc_active();
        if active != last_active {
            if active {
                overlay.show();
            } else {
                overlay.hide();
            }
            last_active = active;
        }
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
fn mc_active() -> bool {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;

    // CGWindowListOption flags. `kCGWindowListOptionOnScreenOnly` (1)
    // restricts to currently-onscreen windows; `kCGWindowListExcludeDesktopElements`
    // (16) drops the desktop background. The two together match what
    // Dock-owned MC windows surface as during an MC activation.
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    const NULL_WINDOW_ID: u32 = 0;

    extern "C" {
        fn CGWindowListCopyWindowInfo(
            option: u32,
            relativeToWindow: u32,
        ) -> CFArrayRef;
    }

    // SAFETY: CGWindowListCopyWindowInfo returns +1 retained CFArray
    // (or null on failure); wrap_under_create_rule consumes the +1.
    let arr_ref = unsafe {
        CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, NULL_WINDOW_ID)
    };
    if arr_ref.is_null() {
        return false;
    }
    let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(arr_ref) };

    let owner_key = CFString::from_static_string("kCGWindowOwnerName");
    let name_key = CFString::from_static_string("kCGWindowName");

    for entry in arr.iter() {
        let dict_ref = entry.as_CFTypeRef() as CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };
        let owner = dict
            .find(owner_key.clone())
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if owner != "Dock" {
            continue;
        }
        let name = dict
            .find(name_key.clone())
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default();
        // macOS 13/14/15 all label the active MC window
        // "Mission Control" via kCGWindowName. Empty kCGWindowName
        // is common for Dock helper windows so the equality check
        // stays tight.
        if name == "Mission Control" {
            return true;
        }
    }
    false
}
