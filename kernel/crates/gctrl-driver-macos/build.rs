// Link the macOS frameworks the FFI feature needs. Only emitted when the
// `ffi` feature is on AND the target is macOS, so Linux / Windows builds
// stay framework-free.
fn main() {
    #[cfg(all(feature = "ffi", target_os = "macos"))]
    {
        // AXIsProcessTrustedWithOptions lives in the ApplicationServices
        // umbrella framework (specifically the HIServices subframework).
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        // CGDisplayCreateUUIDFromDisplayID for cold-index display_uuid.
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        // AppKit for NSWindow / NSScreen used by the overlay renderer.
        println!("cargo:rustc-link-lib=framework=AppKit");
        // SkyLight is loaded at runtime via libloading; no link directive
        // needed (and emitting one would refuse to link on systems where
        // the private framework path moves between major releases).
    }
}
