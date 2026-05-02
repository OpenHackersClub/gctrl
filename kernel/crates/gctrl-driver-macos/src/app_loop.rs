// Main-thread AppKit run loop. Called by the kernel binary on the OS
// main thread before any tokio work runs (the tokio runtime moves to
// a worker thread when this path is taken). Blocks until terminate.

use objc2::msg_send;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use objc2_foundation::MainThreadMarker;

pub fn run() {
    // SAFETY: by contract this function is only called from the OS
    // main thread (`pthread_main_np()` is true). `MainThreadMarker::new`
    // checks that and would return None otherwise — we panic loudly
    // because misrouting AppKit work off the main thread is the kind
    // of bug we want to fail at startup, not silently.
    let mtm = MainThreadMarker::new()
        .expect("driver-macos: run_main_app_loop must be invoked on the OS main thread");
    let app = NSApplication::sharedApplication(mtm);
    // Accessory: kernel daemon doesn't put a Dock icon up. The overlay
    // windows are screen-saver-level and join all Spaces, so the Dock
    // entry would be misleading.
    let _: () = unsafe {
        msg_send![&*app, setActivationPolicy: NSApplicationActivationPolicy::Accessory]
    };
    // Run the loop. Returns when `[NSApp terminate:]` is sent.
    unsafe { app.run() };
}
