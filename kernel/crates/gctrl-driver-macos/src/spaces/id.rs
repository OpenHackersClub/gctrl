// Cold-index keying for stored Space labels.
//
// The CGS-assigned u64 SpaceId is *not stable* across logout/reboot or
// when the user reorders Spaces in Mission Control. Labels are persisted
// keyed on `(machine_id, display_uuid, space_index, space_kind)` instead
// — the **cold index** — and re-associated with whatever live SpaceId the
// CGS reader hands us at runtime.
//
// This module owns the pure-Rust resolver. Given:
//   - the live ordered list of `(SpaceId, kind)` per display (from CGS)
//   - the stored `MacosSpaceLabel` rows (from DuckDB)
// it produces a `Vec<ResolvedSpace>` mapping each live Space to its
// stored label (if any). Unit-tested without any FFI.

use gctrl_core::platform::{MacosSpaceLabel, SpaceId, SpaceKind};

/// One live Space joined with its persisted label. The driver builds
/// `Space` payloads from this — `name` flows from the matched label,
/// `id` / `index` from the live CGS read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSpace {
    pub id: SpaceId,
    pub display_uuid: String,
    pub index: u32,
    pub kind: SpaceKind,
    pub label: Option<String>,
}

/// One row from the live CGS reader. Pure data so unit tests don't need
/// FFI to exercise the resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSpace {
    pub id: SpaceId,
    pub display_uuid: String,
    pub index: u32,
    pub kind: SpaceKind,
}

/// Re-associate stored labels to live Spaces. Match key:
///   `(display_uuid, space_index, space_kind)`
///
/// `cgs_id_hint` from the stored row is a **soft tiebreaker** only — used
/// to pick between two otherwise-identical rows after an index reorder
/// (see test `reorder_keeps_labels_attached_to_displaced_indices`). When
/// no hint matches, fall back to the cold-index match. Stored rows that
/// don't match any live Space are dropped silently — they survive in the
/// table for when the Space comes back, but aren't surfaced.
pub fn resolve(live: &[LiveSpace], stored: &[MacosSpaceLabel]) -> Vec<ResolvedSpace> {
    live.iter()
        .map(|l| ResolvedSpace {
            id: l.id,
            display_uuid: l.display_uuid.clone(),
            index: l.index,
            kind: l.kind,
            label: pick_label(l, stored),
        })
        .collect()
}

fn pick_label(live: &LiveSpace, stored: &[MacosSpaceLabel]) -> Option<String> {
    let kind_str = kind_to_str(live.kind);
    // Prefer hint match — survives a Mission Control reorder where the
    // index rebinds to a different Space.
    if let Some(row) = stored.iter().find(|r| {
        r.cgs_id_hint == Some(live.id.0 as i64)
            && r.display_uuid == live.display_uuid
            && r.space_kind == kind_str
    }) {
        return Some(row.label.clone());
    }
    stored
        .iter()
        .find(|r| {
            r.display_uuid == live.display_uuid
                && r.space_index == live.index as i32
                && r.space_kind == kind_str
        })
        .map(|r| r.label.clone())
}

pub fn kind_to_str(kind: SpaceKind) -> &'static str {
    match kind {
        SpaceKind::User => "user",
        SpaceKind::Fullscreen => "fullscreen",
        SpaceKind::Tiled => "tiled",
    }
}

pub fn kind_from_str(s: &str) -> SpaceKind {
    match s {
        "fullscreen" => SpaceKind::Fullscreen,
        "tiled" => SpaceKind::Tiled,
        _ => SpaceKind::User,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(display: &str, idx: i32, kind: &str, label: &str, hint: Option<i64>) -> MacosSpaceLabel {
        MacosSpaceLabel {
            machine_id: "m".into(),
            display_uuid: display.into(),
            space_index: idx,
            space_kind: kind.into(),
            label: label.into(),
            cgs_id_hint: hint,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn live(id: u64, display: &str, idx: u32, kind: SpaceKind) -> LiveSpace {
        LiveSpace { id: SpaceId(id), display_uuid: display.into(), index: idx, kind }
    }

    #[test]
    fn matches_by_cold_index_when_no_hint() {
        let stored = vec![label("D1", 1, "user", "inbox", None)];
        let lv = vec![live(1001, "D1", 1, SpaceKind::User)];
        let r = resolve(&lv, &stored);
        assert_eq!(r[0].label.as_deref(), Some("inbox"));
    }

    #[test]
    fn unmatched_live_space_has_no_label() {
        let stored = vec![label("D1", 1, "user", "inbox", None)];
        let lv = vec![live(1001, "D1", 2, SpaceKind::User)];
        assert_eq!(resolve(&lv, &stored)[0].label, None);
    }

    #[test]
    fn display_uuid_isolates_labels() {
        let stored = vec![label("D1", 1, "user", "inbox", None)];
        let lv = vec![live(1001, "D2", 1, SpaceKind::User)];
        assert_eq!(resolve(&lv, &stored)[0].label, None);
    }

    #[test]
    fn fullscreen_kind_does_not_match_user_row() {
        let stored = vec![label("D1", 1, "user", "inbox", None)];
        let lv = vec![live(1001, "D1", 1, SpaceKind::Fullscreen)];
        assert_eq!(resolve(&lv, &stored)[0].label, None);
    }

    #[test]
    fn reorder_keeps_labels_attached_to_displaced_indices() {
        // User had: idx=1 "inbox" (cgs=1001), idx=2 "code" (cgs=1002).
        // Then dragged Space 1001 to position 2; CGS now reports
        // [(1002, idx=1), (1001, idx=2)]. With hints, "inbox" should
        // follow Space 1001 to the new index=2 slot.
        let stored = vec![
            label("D1", 1, "user", "inbox", Some(1001)),
            label("D1", 2, "user", "code", Some(1002)),
        ];
        let lv = vec![
            live(1002, "D1", 1, SpaceKind::User),
            live(1001, "D1", 2, SpaceKind::User),
        ];
        let r = resolve(&lv, &stored);
        assert_eq!(r[0].label.as_deref(), Some("code"));
        assert_eq!(r[1].label.as_deref(), Some("inbox"));
    }

    #[test]
    fn cold_index_fallback_when_hint_does_not_match() {
        // Hint is stale (logout cycle reassigned u64 ids). Fall back to
        // index match.
        let stored = vec![label("D1", 1, "user", "inbox", Some(9999))];
        let lv = vec![live(1001, "D1", 1, SpaceKind::User)];
        assert_eq!(resolve(&lv, &stored)[0].label.as_deref(), Some("inbox"));
    }
}
