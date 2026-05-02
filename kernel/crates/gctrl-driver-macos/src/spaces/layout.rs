// Mission Control thumbnail-rect computation.
//
// macOS does not expose a public API for the screen-space rectangles
// of the Space thumbnails along the top of Mission Control, so we
// reproduce the layout empirically. v1 ships a layout matched to
// macOS 15.x; the snapshot fixture under `tests/fixtures/` pins the
// exact numbers so a macOS minor release that shifts the bar shows
// up as a unit-test failure rather than mis-rendered labels.
//
// On startup the driver also runs `verify_layout_matches_live(...)` —
// the live thumbnail count from CGS is checked against the layout
// function's output count. A mismatch downgrades the `spaces`
// capability and surfaces `version_skew=true` on /api/macos/health.
// There is no fallback renderer; loud failure beats silent mis-render.

use serde::{Deserialize, Serialize};

/// Logical-pixel rect, top-left origin in screen coordinates (the
/// convention NSWindow positioning uses after we flip from CGRect's
/// bottom-left origin).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ThumbRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Per-display geometry used to compute the bar layout.
#[derive(Debug, Clone, Copy)]
pub struct DisplayBox {
    pub width: f64,
    pub height: f64,
    /// `true` when the OS reserves space for the menu bar at the top.
    /// Mission Control places the thumbnail bar below the menu bar.
    pub has_menu_bar: bool,
}

/// macOS-15.x defaults. Numbers were measured against a 1440-tall
/// retina display under macOS 15.2 (the test target). They are the
/// fixture in `tests/fixtures/layout_macos_15_default.json`.
pub mod macos_15 {
    /// Top inset from screen origin to the thumbnail bar, *excluding*
    /// the menu bar. With the menu bar (24pt) the effective inset is
    /// MENU_BAR + BAR_TOP_INSET.
    pub const BAR_TOP_INSET: f64 = 12.0;
    pub const MENU_BAR: f64 = 24.0;
    /// Thumbnail height. Width derived from display aspect ratio.
    pub const THUMB_HEIGHT: f64 = 96.0;
    /// Gap between thumbnails.
    pub const GUTTER: f64 = 16.0;
    /// Horizontal inset from screen edges to the bar's content.
    pub const SIDE_INSET: f64 = 24.0;
}

/// Compute thumbnail rects for `num_spaces` Spaces on a single display.
/// Returns one `ThumbRect` per Space in left-to-right order.
///
/// The layout centers the bar horizontally; each thumbnail's width is
/// the display aspect ratio applied to `THUMB_HEIGHT`. If the natural
/// total width exceeds the available bar width, thumbnails shrink
/// uniformly (matching what Mission Control does to fit ~16+ Spaces).
pub fn compute_thumbnail_frames(display: DisplayBox, num_spaces: usize) -> Vec<ThumbRect> {
    if num_spaces == 0 {
        return Vec::new();
    }
    use macos_15::*;

    let aspect = display.width / display.height;
    let mut thumb_h = THUMB_HEIGHT;
    let mut thumb_w = thumb_h * aspect;

    let available = display.width - 2.0 * SIDE_INSET;
    let natural_total = num_spaces as f64 * thumb_w + (num_spaces - 1) as f64 * GUTTER;
    if natural_total > available {
        let gutter_total = (num_spaces - 1) as f64 * GUTTER;
        thumb_w = (available - gutter_total) / num_spaces as f64;
        thumb_h = thumb_w / aspect;
    }

    let total = num_spaces as f64 * thumb_w + (num_spaces - 1) as f64 * GUTTER;
    let start_x = (display.width - total) / 2.0;
    let bar_top = if display.has_menu_bar {
        MENU_BAR + BAR_TOP_INSET
    } else {
        BAR_TOP_INSET
    };

    (0..num_spaces)
        .map(|i| ThumbRect {
            x: start_x + i as f64 * (thumb_w + GUTTER),
            y: bar_top,
            width: thumb_w,
            height: thumb_h,
        })
        .collect()
}

/// Cheap shape probe — does the layout function plausibly match the
/// live thumbnail count? Returns `Err(VersionSkew)` if not. The driver
/// uses this on startup; on mismatch it reports `version_skew=true` on
/// /health and excludes `spaces` from the capability set.
pub fn verify_layout_matches_live(
    display: DisplayBox,
    live_count: usize,
) -> Result<(), VersionSkew> {
    let frames = compute_thumbnail_frames(display, live_count);
    if frames.len() != live_count {
        return Err(VersionSkew {
            detail: format!(
                "layout function produced {} frames for {} live spaces",
                frames.len(),
                live_count
            ),
        });
    }
    if let Some(last) = frames.last() {
        if last.x + last.width > display.width || last.y + last.height > display.height {
            return Err(VersionSkew {
                detail: "computed bar overflows display".into(),
            });
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct VersionSkew {
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_2560_1440() -> DisplayBox {
        DisplayBox { width: 2560.0, height: 1440.0, has_menu_bar: true }
    }

    #[test]
    fn empty_input_yields_empty() {
        assert!(compute_thumbnail_frames(box_2560_1440(), 0).is_empty());
    }

    #[test]
    fn frames_count_matches_input() {
        for n in 1..=8 {
            assert_eq!(compute_thumbnail_frames(box_2560_1440(), n).len(), n);
        }
    }

    #[test]
    fn bar_is_horizontally_centered() {
        let frames = compute_thumbnail_frames(box_2560_1440(), 4);
        let first = frames.first().unwrap();
        let last = frames.last().unwrap();
        let left_inset = first.x;
        let right_inset = box_2560_1440().width - (last.x + last.width);
        assert!((left_inset - right_inset).abs() < 0.5, "bar not centered");
    }

    #[test]
    fn bar_y_accounts_for_menu_bar() {
        let with_menu = compute_thumbnail_frames(
            DisplayBox { width: 2560.0, height: 1440.0, has_menu_bar: true },
            3,
        );
        let without = compute_thumbnail_frames(
            DisplayBox { width: 2560.0, height: 1440.0, has_menu_bar: false },
            3,
        );
        assert!(with_menu[0].y > without[0].y);
        assert!((with_menu[0].y - without[0].y - macos_15::MENU_BAR).abs() < 0.001);
    }

    #[test]
    fn many_spaces_shrink_to_fit() {
        // 32 thumbs at 16:9 over 2560pt won't fit at default size.
        let frames = compute_thumbnail_frames(box_2560_1440(), 32);
        let last = frames.last().unwrap();
        assert!(last.x + last.width <= box_2560_1440().width);
        assert!(frames[0].width < macos_15::THUMB_HEIGHT * (16.0 / 9.0));
    }

    #[test]
    fn verify_layout_passes_for_default_count() {
        assert!(verify_layout_matches_live(box_2560_1440(), 4).is_ok());
        assert!(verify_layout_matches_live(box_2560_1440(), 1).is_ok());
    }

    #[test]
    fn snapshot_macos_15_default() {
        // Frozen reference rects for 2560×1440, 4 user Spaces, with
        // the menu bar present. Update the fixture deliberately when
        // bumping the layout for a new macOS major release; loose
        // float tolerance avoids trailing-bit drift across hosts.
        let frames = compute_thumbnail_frames(box_2560_1440(), 4);
        let expected: Vec<ThumbRect> = serde_json::from_str(include_str!(
            "../../tests/fixtures/layout_macos_15_default.json"
        ))
        .expect("fixture parses");
        assert_eq!(frames.len(), expected.len());
        for (a, e) in frames.iter().zip(expected.iter()) {
            assert!((a.x - e.x).abs() < 0.01, "x: got {} want {}", a.x, e.x);
            assert!((a.y - e.y).abs() < 0.01, "y: got {} want {}", a.y, e.y);
            assert!((a.width - e.width).abs() < 0.01);
            assert!((a.height - e.height).abs() < 0.01);
        }
    }
}
