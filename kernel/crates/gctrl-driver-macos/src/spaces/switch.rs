//! Space switching by the user's Mission Control keyboard shortcuts.
//!
//! macOS has no public API to change the active Space. The driver posts the
//! shortcut the user has bound in System Settings → Keyboard → Keyboard
//! Shortcuts → Mission Control, read from `com.apple.symbolichotkeys`:
//!
//! 1. "Switch to Desktop N" (hotkey ids 118–133) when it is enabled and the
//!    target is a user desktop: one keystroke.
//! 2. Otherwise "Move left a space" / "Move right a space" (ids 79 / 81,
//!    enabled by default as Control-← / Control-→), once per Space between
//!    the current Space and the target.
//!
//! Posting keyboard events requires the Accessibility permission.

use crate::spaces::id::LiveSpace;
use gctrl_core::platform::{PlatformError, SpaceId, SpaceKind};
use serde_json::Value;

pub const MOVE_LEFT: u32 = 79;
pub const MOVE_RIGHT: u32 = 81;
pub const DESKTOP_1: u32 = 118;
const DESKTOP_MAX: usize = 16;

/// `CGEventFlags` bits: Control and the function-key flag arrow keys carry.
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_FN: u64 = 0x0080_0000;
const KEY_LEFT: u16 = 123;
const KEY_RIGHT: u16 = 124;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub keycode: u16,
    /// Modifier mask; the symbolic-hotkeys mask uses the `CGEventFlags` bits.
    pub flags: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// One keystroke lands on the target.
    Direct(Hotkey),
    /// Press `Hotkey` this many times, waiting for each switch.
    Repeat(Hotkey, u32),
}

fn default_hotkey(id: u32) -> Option<Hotkey> {
    let flags = FLAG_CONTROL | FLAG_FN;
    match id {
        MOVE_LEFT => Some(Hotkey {
            keycode: KEY_LEFT,
            flags,
        }),
        MOVE_RIGHT => Some(Hotkey {
            keycode: KEY_RIGHT,
            flags,
        }),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    v.as_bool()
        .or_else(|| v.as_i64().map(|n| n != 0))
        .unwrap_or(false)
}

/// Hotkey `id` from the `AppleSymbolicHotKeys` table, or its macOS default
/// when the table has no entry. `None` when it is disabled or unbound.
pub fn hotkey(table: Option<&Value>, id: u32) -> Option<Hotkey> {
    let Some(entry) = table.and_then(|t| t.get(id.to_string())) else {
        return default_hotkey(id);
    };
    if !entry.get("enabled").is_some_and(truthy) {
        return None;
    }
    let params = entry.pointer("/value/parameters")?.as_array()?;
    let keycode = u16::try_from(params.get(1)?.as_u64()?).ok()?;
    if keycode == u16::MAX {
        return None;
    }
    let flags = params.get(2)?.as_u64()?;
    Some(Hotkey { keycode, flags })
}

/// How to get from `current` to `target`. `spaces` is one display's Spaces
/// in Mission Control order. `Ok(None)` when already there.
pub fn plan(
    spaces: &[LiveSpace],
    current: SpaceId,
    target: SpaceId,
    table: Option<&Value>,
) -> Result<Option<Step>, PlatformError> {
    if current == target {
        return Ok(None);
    }
    let pos = |id: SpaceId| spaces.iter().position(|s| s.id == id);
    let (Some(from), Some(to)) = (pos(current), pos(target)) else {
        return Err(PlatformError::Underlying(format!(
            "space {} is not on the active display",
            target.0
        )));
    };
    if spaces[to].kind == SpaceKind::User {
        let ordinal = spaces[..=to]
            .iter()
            .filter(|s| s.kind == SpaceKind::User)
            .count();
        if ordinal <= DESKTOP_MAX {
            if let Some(hk) = hotkey(table, DESKTOP_1 + ordinal as u32 - 1) {
                return Ok(Some(Step::Direct(hk)));
            }
        }
    }
    let (id, n) = if to > from {
        (MOVE_RIGHT, to - from)
    } else {
        (MOVE_LEFT, from - to)
    };
    let hk = hotkey(table, id).ok_or_else(|| PlatformError::Unsupported {
        what: "the Mission Control \"Move left/right a space\" shortcuts are off".into(),
    })?;
    Ok(Some(Step::Repeat(hk, n as u32)))
}

/// The user's `AppleSymbolicHotKeys` table as JSON.
pub fn read_table() -> Option<Value> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let out = Command::new("/usr/bin/defaults")
        .args(["export", "com.apple.symbolichotkeys", "-"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut child = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(&out.stdout).ok()?;
    let o = child.wait_with_output().ok()?;
    let v: Value = serde_json::from_slice(&o.stdout).ok()?;
    v.get("AppleSymbolicHotKeys").cloned()
}

/// Post `hk` as a key-down/key-up pair at the HID level.
#[cfg(all(feature = "ffi", target_os = "macos"))]
pub fn post(hk: Hotkey) -> Result<(), PlatformError> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| PlatformError::Underlying("CGEventSource unavailable".into()))?;
    let flags = CGEventFlags::from_bits_truncate(hk.flags);
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(src.clone(), hk.keycode, down)
            .map_err(|_| PlatformError::Underlying("CGEvent unavailable".into()))?;
        ev.set_flags(flags);
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn space(id: u64, index: u32, kind: SpaceKind) -> LiveSpace {
        LiveSpace {
            id: SpaceId(id),
            display_uuid: "D".into(),
            index,
            kind,
        }
    }

    fn spaces() -> Vec<LiveSpace> {
        vec![
            space(5, 1, SpaceKind::User),
            space(6, 2, SpaceKind::User),
            space(40, 3, SpaceKind::Fullscreen),
            space(7, 4, SpaceKind::User),
        ]
    }

    #[test]
    fn defaults_to_control_arrows() {
        let step = plan(&spaces(), SpaceId(5), SpaceId(7), None).unwrap();
        assert_eq!(
            step,
            Some(Step::Repeat(
                Hotkey {
                    keycode: KEY_RIGHT,
                    flags: FLAG_CONTROL | FLAG_FN
                },
                3
            ))
        );
        let back = plan(&spaces(), SpaceId(7), SpaceId(6), None).unwrap();
        assert!(matches!(
            back,
            Some(Step::Repeat(
                Hotkey {
                    keycode: KEY_LEFT,
                    ..
                },
                2
            ))
        ));
        assert_eq!(plan(&spaces(), SpaceId(6), SpaceId(6), None).unwrap(), None);
    }

    #[test]
    fn prefers_enabled_switch_to_desktop_shortcut() {
        // Desktop 3 is the third user Space (the fullscreen Space is skipped).
        let table = json!({
            "120": {"enabled": true, "value": {"parameters": [51, 20, 262144], "type": "standard"}},
            "119": {"enabled": false, "value": {"parameters": [50, 19, 262144], "type": "standard"}}
        });
        let step = plan(&spaces(), SpaceId(5), SpaceId(7), Some(&table)).unwrap();
        assert_eq!(
            step,
            Some(Step::Direct(Hotkey {
                keycode: 20,
                flags: 262_144
            }))
        );
        // Desktop 2's shortcut is off: step instead.
        let step = plan(&spaces(), SpaceId(5), SpaceId(6), Some(&table)).unwrap();
        assert!(matches!(step, Some(Step::Repeat(_, 1))));
    }

    #[test]
    fn reports_disabled_arrows_and_foreign_display() {
        let table = json!({"81": {"enabled": false}});
        assert!(matches!(
            plan(&spaces(), SpaceId(5), SpaceId(7), Some(&table)),
            Err(PlatformError::Unsupported { .. })
        ));
        assert!(matches!(
            plan(&spaces(), SpaceId(5), SpaceId(99), None),
            Err(PlatformError::Underlying(_))
        ));
    }
}
