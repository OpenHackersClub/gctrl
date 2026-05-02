// Real `SpacesPort` impl wired around:
//   - the CGS reader (live Space enumeration)
//   - the cold-index resolver (re-associating stored labels)
//   - the layout function (thumbnail rect computation)
//   - the AX overlay (rendering)
//   - the storage adapter (label persistence)
//
// Default-feature builds compile only the stub paths; FfiSpaces lives
// behind `cfg(all(feature = "ffi", target_os = "macos"))` and is
// returned by `default_driver()` on that target. On every other
// target the kernel keeps using `StubDriver`.

pub mod cgs;
pub mod id;
pub mod layout;
pub mod mc_detect;
pub mod overlay;

use std::sync::Arc;

use gctrl_core::platform::{
    MacosSpaceLabel, PlatformError, Space, SpaceEvent, SpaceId, SpacesPort,
};
use gctrl_storage::DuckDbStore;
use tokio::sync::broadcast;

use crate::{machine_id, primary_display_uuid, PLACEHOLDER_SPACE_KIND};

/// Live driver state shared by the FfiSpaces port and the routes
/// module. The event channel is the source of truth for the SSE
/// stream; the storage adapter owns label persistence; the overlay
/// owns rendering.
pub struct SpacesState {
    pub store: Arc<DuckDbStore>,
    pub events: broadcast::Sender<SpaceEvent>,
    pub overlay: Arc<overlay::Overlay>,
}

impl SpacesState {
    pub fn new(store: Arc<DuckDbStore>) -> Self {
        let (tx, _) = broadcast::channel(64);
        let overlay = overlay::Overlay::spawn();
        // Toggle the overlay whenever Mission Control activates /
        // dismisses. The detector spawns a tokio task; in non-tokio
        // contexts (unit tests) the spawn will panic-on-no-runtime,
        // so we only run it when there's a current handle.
        if tokio::runtime::Handle::try_current().is_ok() {
            mc_detect::spawn(overlay.clone());
        }
        Self {
            store,
            events: tx,
            overlay,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SpaceEvent> {
        self.events.subscribe()
    }
}

/// Storage-only `SpacesPort` used when the `ffi` feature is off but
/// the routes still want a port for `current()` / `name()`. With FFI
/// off we have no live CGS data, so `current()` returns Unsupported
/// and `list()` synthesizes a Space per stored label.
pub struct StorageSpaces {
    pub state: Arc<SpacesState>,
}

impl SpacesPort for StorageSpaces {
    fn list(&self) -> Result<Vec<Space>, PlatformError> {
        let labels = self
            .state
            .store
            .list_macos_labels(&machine_id(), None)
            .map_err(|e| PlatformError::Underlying(e.to_string()))?;
        Ok(labels
            .iter()
            .map(|l| crate::stub_space_for_label(l, false))
            .collect())
    }

    fn current(&self) -> Result<Space, PlatformError> {
        Err(PlatformError::Unsupported {
            what: "spaces.current (FFI feature not enabled)".into(),
        })
    }

    fn name(&self, space_id: SpaceId, name: &str) -> Result<(), PlatformError> {
        persist_label(&self.state, space_id, name)?;
        let _ = self
            .state
            .events
            .send(SpaceEvent::Renamed { id: space_id, name: Some(name.to_string()) });
        Ok(())
    }

    fn unname(&self, space_id: SpaceId) -> Result<(), PlatformError> {
        let removed = self
            .state
            .store
            .delete_macos_label(
                &machine_id(),
                &primary_display_uuid(),
                space_id.0 as i32,
                PLACEHOLDER_SPACE_KIND,
            )
            .map_err(|e| PlatformError::Underlying(e.to_string()))?;
        if !removed {
            return Err(PlatformError::Underlying("label not found".into()));
        }
        let _ = self
            .state
            .events
            .send(SpaceEvent::Renamed { id: space_id, name: None });
        Ok(())
    }

    fn switch_to(&self, _space_id: SpaceId) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported {
            what: "spaces.switch_to (FFI feature not enabled)".into(),
        })
    }
}

fn persist_label(
    state: &SpacesState,
    space_id: SpaceId,
    name: &str,
) -> Result<(), PlatformError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(PlatformError::Underlying("label is empty".into()));
    }
    let row = MacosSpaceLabel {
        machine_id: machine_id(),
        display_uuid: primary_display_uuid(),
        space_index: space_id.0 as i32,
        space_kind: PLACEHOLDER_SPACE_KIND.into(),
        label: trimmed.into(),
        cgs_id_hint: Some(space_id.0 as i64),
        created_at: String::new(),
        updated_at: String::new(),
    };
    state
        .store
        .upsert_macos_label(&row)
        .map_err(|e| PlatformError::Underlying(e.to_string()))?;
    repaint_overlay(state);
    Ok(())
}

fn repaint_overlay(state: &SpacesState) {
    // Pull current labels and ask the overlay to update. Layout
    // rects are computed against a default 2560×1440 box for now;
    // the FfiSpaces variant below replaces this with the live
    // primary-display geometry.
    let labels = state
        .store
        .list_macos_labels(&machine_id(), None)
        .unwrap_or_default();
    if labels.is_empty() {
        state.overlay.hide();
        return;
    }
    let display = layout::DisplayBox {
        width: 2560.0,
        height: 1440.0,
        has_menu_bar: true,
    };
    let frames = layout::compute_thumbnail_frames(display, labels.len());
    let labelled: Vec<overlay::LabeledRect> = labels
        .iter()
        .zip(frames.iter())
        .map(|(l, r)| overlay::LabeledRect { rect: *r, label: l.label.clone() })
        .collect();
    state.overlay.set_labels(labelled);
    state.overlay.show();
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
pub mod ffi_port {
    use super::*;
    use crate::spaces::cgs::Cgs;
    use crate::spaces::id::{kind_to_str, resolve, LiveSpace};
    use gctrl_core::platform::{PlatformError, Space, SpaceId, SpacesPort};

    /// FFI-backed `SpacesPort`. Reads live Space data from CGS,
    /// joins it with persisted labels via the cold-index resolver,
    /// and pushes the labelled rect set to the overlay on every
    /// `name()` call.
    pub struct FfiSpaces {
        pub state: std::sync::Arc<SpacesState>,
        pub cgs: Cgs,
    }

    impl FfiSpaces {
        pub fn open(state: std::sync::Arc<SpacesState>) -> Option<Self> {
            Cgs::open().map(|cgs| Self { state, cgs })
        }

        fn live(&self, display_uuid: &str) -> Result<Vec<LiveSpace>, PlatformError> {
            self.cgs.copy_spaces(display_uuid).ok_or_else(|| {
                PlatformError::VersionSkew {
                    detail: "CGS returned no Space list — private symbol shape may have moved"
                        .into(),
                }
            })
        }
    }

    impl SpacesPort for FfiSpaces {
        fn list(&self) -> Result<Vec<Space>, PlatformError> {
            let display = primary_display_uuid();
            let live = self.live(&display)?;
            let stored = self
                .state
                .store
                .list_macos_labels(&machine_id(), Some(&display))
                .map_err(|e| PlatformError::Underlying(e.to_string()))?;
            let resolved = resolve(&live, &stored);
            let current_id = self.cgs.current_space(&display);
            Ok(resolved
                .into_iter()
                .map(|r| Space {
                    id: r.id,
                    display_id: 0,
                    display_uuid: r.display_uuid,
                    index: r.index,
                    kind: r.kind,
                    name: r.label,
                    system_label: format!("Desktop {}", r.index),
                    is_current: current_id == Some(r.id),
                })
                .collect())
        }

        fn current(&self) -> Result<Space, PlatformError> {
            let display = primary_display_uuid();
            let live = self.live(&display)?;
            let current = self
                .cgs
                .current_space(&display)
                .ok_or(PlatformError::DisplayGone)?;
            let l = live
                .into_iter()
                .find(|l| l.id == current)
                .ok_or(PlatformError::DisplayGone)?;
            let stored = self
                .state
                .store
                .list_macos_labels(&machine_id(), Some(&display))
                .map_err(|e| PlatformError::Underlying(e.to_string()))?;
            let label = stored
                .iter()
                .find(|s| {
                    s.display_uuid == l.display_uuid
                        && s.space_index == l.index as i32
                        && s.space_kind == kind_to_str(l.kind)
                })
                .map(|s| s.label.clone());
            Ok(Space {
                id: l.id,
                display_id: 0,
                display_uuid: l.display_uuid,
                index: l.index,
                kind: l.kind,
                name: label,
                system_label: format!("Desktop {}", l.index),
                is_current: true,
            })
        }

        fn name(&self, space_id: SpaceId, name: &str) -> Result<(), PlatformError> {
            persist_label(&self.state, space_id, name)?;
            let _ = self
                .state
                .events
                .send(SpaceEvent::Renamed { id: space_id, name: Some(name.to_string()) });
            Ok(())
        }

        fn unname(&self, space_id: SpaceId) -> Result<(), PlatformError> {
            StorageSpaces { state: self.state.clone() }.unname(space_id)
        }

        fn switch_to(&self, _space_id: SpaceId) -> Result<(), PlatformError> {
            // Switching Spaces from a non-foreground process requires
            // either a synthesized CGEvent matching the user's
            // configured shortcut (fragile, accessibility-required)
            // or a private CGS API (rejected v1). Keep this
            // Unsupported until the spec calls a strategy.
            Err(PlatformError::Unsupported {
                what: "spaces.switch_to deferred to follow-up".into(),
            })
        }
    }
}

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
pub fn make_port(state: Arc<SpacesState>) -> Option<Box<dyn SpacesPort>> {
    Some(Box::new(StorageSpaces { state }))
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
pub fn make_port(state: Arc<SpacesState>) -> Option<Box<dyn SpacesPort>> {
    if let Some(port) = ffi_port::FfiSpaces::open(state.clone()) {
        return Some(Box::new(port));
    }
    Some(Box::new(StorageSpaces { state }))
}
