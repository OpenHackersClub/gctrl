// AX-driven NSWindow overlay — the only renderer for named Spaces.
//
// One transparent borderless NSWindow per label (pooled across MC
// activations), level `NSScreenSaverWindowLevel + 1`, collection
// behavior `canJoinAllSpaces | stationary | ignoresCycle`. Each window
// hosts an NSTextField rendering the label text.
//
// Threading model: `Overlay` is constructed and held by the kernel's
// async runtime worker. Every method posts a closure to
// `dispatch_get_main_queue()` so the AppKit calls execute on the OS
// main thread (where `gctrl_driver_macos::run_main_app_loop` is
// blocked in `NSApp.run()`).
//
// On non-FFI / non-macOS builds the body collapses to a no-op stub.

#[allow(unused_imports)]
use std::sync::Arc;

use crate::spaces::layout::ThumbRect;

#[derive(Debug, Clone)]
pub struct LabeledRect {
    pub rect: ThumbRect,
    pub label: String,
}

/// Public handle the FfiDriver pokes from the kernel runtime. All
/// methods are safe to call from any thread; AppKit work is bounced
/// onto the OS main thread via libdispatch.
pub struct Overlay {
    #[allow(dead_code)]
    inner: OverlayInner,
}

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
struct OverlayInner;

#[cfg(not(all(feature = "ffi", target_os = "macos")))]
impl Overlay {
    pub fn spawn() -> Arc<Self> {
        Arc::new(Self { inner: OverlayInner })
    }
    pub fn set_labels(&self, _labels: Vec<LabeledRect>) {}
    pub fn show(&self) {}
    pub fn hide(&self) {}
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
mod mac {
    use super::{LabeledRect, Overlay};
    use std::sync::Arc;

    pub(super) struct OverlayInner;

    impl Overlay {
        pub fn spawn() -> Arc<Self> {
            // Lazy: AppKit setup happens the first time a closure
            // arrives on the main queue. Constructing the Overlay is
            // free — no thread, no AppKit calls.
            Arc::new(Self { inner: OverlayInner })
        }

        pub fn set_labels(&self, labels: Vec<LabeledRect>) {
            dispatch_to_main(move || ns::set_labels(labels));
        }
        pub fn show(&self) {
            dispatch_to_main(move || ns::show());
        }
        pub fn hide(&self) {
            dispatch_to_main(move || ns::hide());
        }
    }

    fn dispatch_to_main<F: FnOnce() + Send + 'static>(work: F) {
        // dispatch2's Queue::main() returns a handle to the main
        // dispatch queue; exec_async puts the closure on it. The work
        // runs only when the main thread is pumping the run loop —
        // i.e. inside `NSApp.run()` (see app_loop.rs).
        dispatch2::Queue::main().exec_async(work);
    }

    /// Main-thread NSWindow lifecycle. All functions here MUST be
    /// called on the main thread; the dispatch_to_main hop above
    /// guarantees that.
    pub(super) mod ns {
        use super::LabeledRect;
        use crate::spaces::layout::ThumbRect;
        use objc2::rc::Retained;
        use objc2_app_kit::{
            NSBackingStoreType, NSColor, NSScreen, NSTextField, NSView, NSWindow,
            NSWindowCollectionBehavior, NSWindowStyleMask,
        };
        use objc2_foundation::{
            MainThreadMarker, NSPoint, NSRect, NSSize, NSString,
        };
        use std::cell::RefCell;

        /// `kCGScreenSaverWindowLevel`. Hard-coded to the published
        /// constant rather than calling `CGShieldingWindowLevel()` so
        /// we don't pay an extra FFI hop per window.
        const NS_SCREEN_SAVER_WINDOW_LEVEL: isize = 1000;

        struct Slot {
            window: Retained<NSWindow>,
            field: Retained<NSTextField>,
        }

        thread_local! {
            // Pooled NSWindow handles. Lives on the main thread for
            // the daemon's lifetime; we reposition + relabel on each
            // `set_labels` rather than recreating.
            static SLOTS: RefCell<Vec<Slot>> = const { RefCell::new(Vec::new()) };
            static REQUESTED_VISIBLE: RefCell<bool> = const { RefCell::new(false) };
        }

        pub(super) fn set_labels(labels: Vec<LabeledRect>) {
            let mtm = match MainThreadMarker::new() {
                Some(m) => m,
                None => {
                    tracing::error!("overlay::set_labels invoked off main thread");
                    return;
                }
            };
            ensure_capacity(mtm, labels.len());
            SLOTS.with(|cell| {
                let slots = cell.borrow();
                let visible = REQUESTED_VISIBLE.with(|v| *v.borrow());
                for (i, slot) in slots.iter().enumerate() {
                    if let Some(lr) = labels.get(i) {
                        position_window(&slot.window, lr.rect);
                        set_label_text(&slot.field, &lr.label);
                        if visible {
                            unsafe { slot.window.orderFrontRegardless() };
                        }
                    } else {
                        slot.window.orderOut(None);
                    }
                }
            });
        }

        pub(super) fn show() {
            REQUESTED_VISIBLE.with(|v| *v.borrow_mut() = true);
            SLOTS.with(|cell| {
                for slot in cell.borrow().iter() {
                    unsafe { slot.window.orderFrontRegardless() };
                }
            });
        }

        pub(super) fn hide() {
            REQUESTED_VISIBLE.with(|v| *v.borrow_mut() = false);
            SLOTS.with(|cell| {
                for slot in cell.borrow().iter() {
                    slot.window.orderOut(None);
                }
            });
        }

        fn ensure_capacity(mtm: MainThreadMarker, n: usize) {
            SLOTS.with(|cell| {
                let mut v = cell.borrow_mut();
                while v.len() < n {
                    v.push(make_slot(mtm));
                }
            });
        }

        fn make_slot(mtm: MainThreadMarker) -> Slot {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
            // SAFETY: MainThreadMarker::alloc bypasses the
            // IsAllocableAnyThread bound that NSWindow lacks; init
            // consumes the +1 alloc retain.
            let window: Retained<NSWindow> = unsafe {
                NSWindow::initWithContentRect_styleMask_backing_defer(
                    mtm.alloc::<NSWindow>(),
                    frame,
                    NSWindowStyleMask::Borderless,
                    NSBackingStoreType::NSBackingStoreBuffered,
                    false,
                )
            };
            unsafe {
                window.setOpaque(false);
                let clear = NSColor::clearColor();
                window.setBackgroundColor(Some(&clear));
                window.setIgnoresMouseEvents(true);
                window.setLevel(NS_SCREEN_SAVER_WINDOW_LEVEL + 1);
                window.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces
                        | NSWindowCollectionBehavior::Stationary
                        | NSWindowCollectionBehavior::IgnoresCycle,
                );
                window.setHasShadow(false);
            }
            // NSTextField fills the window's content view; the field
            // is configured as a non-editable, transparent-background
            // label.
            let field: Retained<NSTextField> =
                unsafe { NSTextField::initWithFrame(mtm.alloc::<NSTextField>(), frame) };
            unsafe {
                field.setEditable(false);
                field.setSelectable(false);
                field.setBordered(false);
                field.setBezeled(false);
                field.setDrawsBackground(false);
                let white = NSColor::whiteColor();
                field.setTextColor(Some(&white));
            }
            // Install field as the window's content view.
            let view: &NSView = &field;
            window.setContentView(Some(view));
            Slot { window, field }
        }

        fn position_window(w: &NSWindow, rect: ThumbRect) {
            let screen_h = primary_screen_height();
            // AppKit origin is bottom-left; layout rects are top-left.
            let y = screen_h - rect.y - rect.height;
            let frame = NSRect::new(
                NSPoint::new(rect.x, y),
                NSSize::new(rect.width, rect.height),
            );
            w.setFrame_display(frame, true);
        }

        fn set_label_text(f: &NSTextField, label: &str) {
            let s = NSString::from_str(label);
            unsafe { f.setStringValue(&s) };
        }

        fn primary_screen_height() -> f64 {
            let mtm = match MainThreadMarker::new() {
                Some(m) => m,
                None => return 0.0,
            };
            if let Some(screen) = NSScreen::mainScreen(mtm) {
                screen.frame().size.height
            } else {
                0.0
            }
        }
    }
}

#[cfg(all(feature = "ffi", target_os = "macos"))]
use mac::OverlayInner;
