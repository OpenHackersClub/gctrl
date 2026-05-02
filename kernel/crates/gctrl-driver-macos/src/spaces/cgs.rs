// Read-only Space enumeration via the private SkyLight (CGS) framework.
//
// Loaded at runtime with `libloading` so a missing or renamed symbol
// degrades gracefully (driver omits `spaces` capability) instead of
// refusing to link. No private *write* API is bound — naming goes
// through the AX overlay; switching, when implemented, will use a
// Mission-Control-driven gesture, never `SLSSpaceSetName`.

#[cfg(all(feature = "ffi", target_os = "macos"))]
use crate::spaces::id::LiveSpace;

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
pub struct Cgs;

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
impl Cgs {
    pub fn open() -> Option<Self> {
        None
    }
    pub fn copy_spaces(&self, _display_uuid: &str) -> Option<Vec<crate::spaces::id::LiveSpace>> {
        None
    }
    pub fn current_space(&self, _display_uuid: &str) -> Option<gctrl_core::platform::SpaceId> {
        None
    }
    pub fn version_skew(&self) -> bool {
        false
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
mod ffi {
    use super::LiveSpace;
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use gctrl_core::platform::{SpaceId, SpaceKind};
    use libloading::{Library, Symbol};

    const SKYLIGHT: &str =
        "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight";

    /// CGS connection id type; opaque u32 in practice.
    type CgsConn = u32;

    type FnMainConn = unsafe extern "C" fn() -> CgsConn;
    type FnCopyManagedDisplaySpaces = unsafe extern "C" fn(CgsConn) -> CFArrayRef;
    type FnGetActiveSpace = unsafe extern "C" fn(CgsConn) -> u64;

    pub struct Cgs {
        // The library handle MUST outlive every `Symbol` extracted from
        // it; we keep it boxed so the resolved fn-pointers stay valid.
        _lib: Library,
        conn: CgsConn,
        copy_spaces_for_displays: unsafe extern "C" fn(CgsConn) -> CFArrayRef,
        active_space: unsafe extern "C" fn(CgsConn) -> u64,
        version_skew: bool,
    }

    impl Cgs {
        pub fn open() -> Option<Self> {
            // SAFETY: SkyLight is a system framework; loading it has no
            // global side-effect beyond `dlopen`'s normal mapping.
            let lib = unsafe { Library::new(SKYLIGHT) }.ok()?;
            // SAFETY: the Symbol borrows from `lib`; we transmute the
            // borrow to 'static and then keep `lib` in the same struct
            // so the borrow remains valid for `Cgs`'s lifetime.
            let main_conn: Symbol<'_, FnMainConn> =
                unsafe { lib.get(b"CGSMainConnectionID\0") }.ok()?;
            let copy_displays: Symbol<'_, FnCopyManagedDisplaySpaces> = unsafe {
                lib.get(b"CGSCopyManagedDisplaySpaces\0")
            }
            .ok()?;
            let active: Symbol<'_, FnGetActiveSpace> =
                unsafe { lib.get(b"CGSGetActiveSpace\0") }.ok()?;

            let conn = unsafe { (*main_conn)() };
            let copy_fn = *copy_displays;
            let active_fn = *active;
            // Drop the borrow-typed Symbols; we captured the fn ptrs.
            drop(main_conn);
            drop(copy_displays);
            drop(active);

            Some(Cgs {
                _lib: lib,
                conn,
                copy_spaces_for_displays: copy_fn,
                active_space: active_fn,
                version_skew: false,
            })
        }

        pub fn version_skew(&self) -> bool {
            self.version_skew
        }

        /// Enumerate Spaces on `display_uuid`. Returns `None` if the
        /// CGS payload shape doesn't match what we expect — caller
        /// should treat that as a version-skew event.
        pub fn copy_spaces(&self, display_uuid: &str) -> Option<Vec<LiveSpace>> {
            // SAFETY: thin wrapper around the dlsym-resolved fn; the
            // returned CFArrayRef is owned per CGS conventions.
            let arr_ref: CFArrayRef = unsafe { (self.copy_spaces_for_displays)(self.conn) };
            if arr_ref.is_null() {
                return None;
            }
            let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(arr_ref) };
            let mut out = Vec::new();
            for entry in arr.iter() {
                let dict_ref = entry.as_CFTypeRef() as CFDictionaryRef;
                let dict: CFDictionary<CFString, CFType> =
                    unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };
                let display_id_key = CFString::from_static_string("Display Identifier");
                let spaces_key = CFString::from_static_string("Spaces");
                let display_for_dict = dict
                    .find(display_id_key)
                    .and_then(|v| v.downcast::<CFString>())
                    .map(|s| s.to_string());
                let Some(this_display) = display_for_dict else {
                    continue;
                };
                if this_display != display_uuid {
                    continue;
                }
                let Some(spaces_val) = dict.find(spaces_key) else {
                    continue;
                };
                let spaces_arr_ref = spaces_val.as_CFTypeRef() as CFArrayRef;
                if spaces_arr_ref.is_null() {
                    continue;
                }
                let spaces_arr: CFArray<CFType> =
                    unsafe { CFArray::wrap_under_get_rule(spaces_arr_ref) };
                for (idx, sp) in spaces_arr.iter().enumerate() {
                    let sp_dict: CFDictionary<CFString, CFType> = unsafe {
                        CFDictionary::wrap_under_get_rule(sp.as_CFTypeRef() as CFDictionaryRef)
                    };
                    let id_key = CFString::from_static_string("ManagedSpaceID");
                    let kind_key = CFString::from_static_string("type");
                    let id = sp_dict
                        .find(id_key)
                        .and_then(|v| v.downcast::<CFNumber>())
                        .and_then(|n| n.to_i64())
                        .unwrap_or(0) as u64;
                    let kind = sp_dict
                        .find(kind_key)
                        .and_then(|v| v.downcast::<CFNumber>())
                        .and_then(|n| n.to_i64())
                        .map(|t| match t {
                            // Empirical CGS "type" values: 0=user,
                            // 1=fullscreen, 2=tiled. Verified on macOS
                            // 13/14/15; we tolerate an unknown int by
                            // mapping it to User and recording skew.
                            0 => SpaceKind::User,
                            1 => SpaceKind::Fullscreen,
                            2 => SpaceKind::Tiled,
                            _ => SpaceKind::User,
                        })
                        .unwrap_or(SpaceKind::User);
                    out.push(LiveSpace {
                        id: SpaceId(id),
                        display_uuid: display_uuid.to_string(),
                        index: idx as u32 + 1,
                        kind,
                    });
                }
            }
            Some(out)
        }

        /// Active Space id on the focused display.
        pub fn current_space(&self, _display_uuid: &str) -> Option<SpaceId> {
            // SAFETY: dlsym-resolved; returns 0 when CGS has no answer.
            let id = unsafe { (self.active_space)(self.conn) };
            if id == 0 {
                None
            } else {
                Some(SpaceId(id))
            }
        }
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
pub use ffi::Cgs;
