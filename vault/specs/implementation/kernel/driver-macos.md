# `driver-macos` — Implementation

Concrete crate layout, FFI bindings, build flags, entitlements, and the v1 ship plan for the macOS platform driver. Architecture and rationale live in [architecture/kernel/driver-macos.md](../../architecture/kernel/driver-macos.md); this document only fills in the *how*.

## Crate Layout

New crate `kernel/crates/gctrl-driver-macos/` registered under `[workspace] members` in the root `Cargo.toml`.

```
kernel/crates/gctrl-driver-macos/
├── Cargo.toml
├── build.rs                              # cargo:rustc-link-framework directives
├── src/
│   ├── lib.rs                            # PlatformPort impl, capability registration
│   ├── error.rs                          # PlatformError (Schema.TaggedError equivalent)
│   ├── routes.rs                         # axum router → mounted at /api/macos
│   ├── spaces/
│   │   ├── mod.rs                        # SpacesPort impl
│   │   ├── cgs.rs                        # `unsafe` CGS / SkyLight FFI (read-only)
│   │   ├── overlay.rs                    # AX-driven NSWindow overlay (the only renderer)
│   │   ├── layout.rs                     # thumbnail-rect computation per macOS version
│   │   ├── store.rs                      # DuckDB persistence (macos_space_labels)
│   │   └── id.rs                         # SpaceId, cold-index keying, re-association
│   ├── permissions.rs                    # AX / notifications status probes
│   └── health.rs                         # /api/macos/health response builder
├── tests/
│   └── spaces_smoke.rs                   # gated on --features integration-macos
└── README.md
```

The crate compiles only when `target_os = "macos"`. On other targets `lib.rs` reduces to a stub that returns `None` from `PlatformPort::os()` and is excluded from the binary by `cfg`.

## Cargo Features

```toml
# kernel/crates/gctrl-driver-macos/Cargo.toml
[package]
name = "gctrl-driver-macos"
version.workspace = true
edition.workspace = true

[features]
default = []
# Enables real FFI; without this the crate compiles but PlatformPort returns
# capabilities=[], so a stripped-down kernel build can still link cleanly.
ffi = ["objc2", "objc2-app-kit", "objc2-foundation", "core-graphics", "core-foundation"]
# Pulls in tokio fixtures for the spaces_smoke integration test.
integration-macos = ["ffi"]

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = { version = "0.5", optional = true }
objc2-app-kit = { version = "0.2", optional = true }
objc2-foundation = { version = "0.2", optional = true }
core-graphics = { version = "0.24", optional = true }
core-foundation = { version = "0.10", optional = true }
libloading = "0.8"           # for dlsym probes against SkyLight private symbols
```

The default-build kernel does NOT depend on the `ffi` feature so contributors on Linux can build the kernel without an Apple toolchain. The macOS desktop release pipeline turns it on:

```toml
# kernel/crates/gctrl-cli/Cargo.toml
[features]
default = ["macos-platform"]
macos-platform = ["gctrl-driver-macos/ffi"]
```

`gctrl-driver-macos` is added to `gctrl-cli`'s dependencies behind `cfg(target_os = "macos")` so it links into the `gctrld` binary on macOS only.

## FFI Bindings — Strategy Reference

### Public AppKit / Foundation

Used for the overlay windows and Accessibility probes. All accessed via `objc2-app-kit` and `objc2-foundation`; no manual `#[link(name = "AppKit")]`.

```rust
use objc2_app_kit::{NSWindow, NSScreen, NSWindowStyleMask, NSWindowCollectionBehavior};
use objc2_foundation::{NSRect, NSString};
```

### CoreGraphics — public

`CGDisplayCreateUUIDFromDisplayID` for the cold-index `display_uuid`. `core-graphics` crate, no `unsafe` block at the call site.

### CGS / SkyLight — private

Only used for **read-only** Space enumeration on macOS ≥ 13. Loaded via `libloading::Library::new("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight")` so a missing or renamed symbol degrades gracefully instead of refusing to link.

```rust
// spaces/cgs.rs   (sketch)
type CGSCopySpaces = unsafe extern "C" fn(/* options */ u32) -> CFArrayRef;
type CGSManagedDisplayGetCurrentSpace =
    unsafe extern "C" fn(connection: CGSConnectionID, display_uuid: CFStringRef) -> u64;

pub struct Cgs {
    lib: libloading::Library,
    connection: CGSConnectionID,
    copy_spaces: Option<libloading::Symbol<'static, CGSCopySpaces>>,
    current_space: Option<libloading::Symbol<'static, CGSManagedDisplayGetCurrentSpace>>,
}
```

Each FFI call is wrapped in:

1. A `Cgs::probe()` capability check at construction time (`dlsym` returns `Some` for every required symbol). If any probe fails, `Cgs::new()` returns `None` and the driver reports `capabilities` without `spaces`.
2. A bounded retry harness so a transient `kCGErrorIllegalArgument` from a Mission Control transition is retried once after a 16 ms sleep.
3. An OTel span (`driver.macos.cgs.copy_spaces`) attributing latency and `version_skew` boolean attributes.

**No private SkyLight write APIs are linked in v1.** The only writes go through public `NSWindow` and AppKit ops; the rejected `SLSSpaceSetName` path is documented in the architecture spec but never compiled in.

### Accessibility (AX)

```rust
use core_foundation::{base::TCFType, dictionary::CFDictionary, string::CFString};

extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}
```

`AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt = true` is the one and only prompt the driver triggers. It is gated behind a user-initiated `name()` call — never on driver init.

## HTTP Routes

Mounted under `/api/macos` via `gctrl-driver-macos::routes::router(state)`, then composed into the existing `kernel/crates/gctrl-cli/src/commands/serve.rs` axum tree alongside `/api/github` etc.

```rust
// gctrl-driver-macos/src/routes.rs   (sketch)
pub fn router(state: DriverState) -> axum::Router {
    Router::new()
        .route("/health",                     get(health::handler))
        .route("/spaces",                     get(spaces::list_handler))
        .route("/spaces/current",             get(spaces::current_handler))
        .route("/spaces/:id/name",            post(spaces::name_handler).delete(spaces::unname_handler))
        .route("/spaces/:id/switch",          post(spaces::switch_handler))
        .route("/spaces/stream",              get(spaces::stream_handler))
        .route("/power",                      get(power_status_handler).post(set_power_handler))
        .with_state(state)
}
```

`health::handler` is the only route that does NOT require the `ffi` feature; it always returns `{ os: "macos", capabilities: [], permissions: { ... } }` when ffi is disabled, so consumers can feature-detect even on a stripped build.

The kernel's existing TTL cache wraps `GET /api/macos/spaces` with a 5 s TTL; write routes (`/name`, `/unname`, `/switch`) call `cache.invalidate("/api/macos/spaces*")` on success, mirroring [`driver-github`'s pattern](../dogfood-drivers.md). The `/power` routes are not cached — status is read straight off the in-process assertion handle.

## Power Assertion (prevent sleep)

`src/power.rs` implements the [`PowerPort` prevent-sleep capability](../../architecture/kernel/driver-macos.md#powerport--prevent-sleep-caffeinate) — the Caffeine replacement.

- **IOKit FFI** (`#[cfg(all(feature = "ffi", target_os = "macos"))]`): two `extern "C"` symbols, `IOPMAssertionCreateWithName(type, level=255, name, &id)` and `IOPMAssertionRelease(id)`, linked via `cargo:rustc-link-lib=framework=IOKit` in `build.rs`. The assertion *type* is the IOKit string `PreventUserIdleDisplaySleep` (default) or `PreventUserIdleSystemSleep`; the *name* is the reason surfaced in `pmset -g assertions`.
- **One assertion at a time.** `MacPower` holds `Mutex<Option<assertion_id>>`. `set_prevent_sleep` releases any existing id before creating a new one, so toggling off and switching `kind` are the same code path and ids never leak or double-release.
- **Default-on.** `FfiDriver::new` calls `power::default_from_env(GCTRL_PREVENT_SLEEP)` → `Some(Display)` by default and immediately enables the assertion, so the headline "Mac won't sleep while gctrl runs" holds with zero user action. `off`/`0`/`false` disables; `system` selects the system-only type.
- **Stub on every other target.** `NoopPower` reports `supported: false` and returns `PlatformError::Unsupported` from `set_prevent_sleep`, so Linux/Windows builds and `cargo build` without `ffi` keep compiling and the route returns `501` on POST.
- **Cleanup.** The OS releases the assertion on process exit; `MacPower`'s `Drop` releases it explicitly for graceful shutdown.

### Cache & Telemetry

Per [os.md § Driver Execution Model](../../architecture/os.md#driver-execution-model--kernel-responsibilities), caching and OTel are kernel concerns, not driver concerns. The driver emits **one span per public method**, and the kernel's middleware adds the cache, the request span, and secret resolution. Driver code does not call `tracing::info_span!` directly — it uses the project's `#[instrument]` macro on each `SpacesPort` method.

## Persistence

DuckDB migration `kernel/crates/gctrl-storage/migrations/00NN_macos_space_labels.sql` (numbering decided when the PR is opened; current head is `0042`):

```sql
CREATE TABLE IF NOT EXISTS macos_space_labels (
  machine_id   VARCHAR NOT NULL,
  display_uuid VARCHAR NOT NULL,
  space_index  INTEGER NOT NULL,
  space_kind   VARCHAR NOT NULL,
  label        VARCHAR NOT NULL,
  cgs_id_hint  BIGINT,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, display_uuid, space_index, space_kind)
);

CREATE INDEX IF NOT EXISTS idx_macos_space_labels_label
  ON macos_space_labels (label);
```

`machine_id` resolves from the existing kernel `node_identity` row (single row written on first boot). The driver MUST NOT create its own machine identifier.

[sync.md](../../architecture/kernel/sync.md) skips this table by default — it is local-only state. A future "label-by-role" sync schema will live in a separate `macos_space_roles` table; the v1 table stays simple.

## AX Overlay — the only renderer

`spaces/overlay.rs` owns the user-visible naming behavior. The driver requires Accessibility permission; without it, `spaces` is not advertised in `capabilities` and `name()` returns `PermissionDenied`.

### Activation pipeline

1. On driver start (after first label is set), spawn a `tokio::task` running an `AXObserver` listening on the Dock process for the `kAXFocusedUIElementChangedNotification` and a synthetic `kAXMissionControlActivatedNotification` we derive from window-list changes (private notifications are unreliable across versions; we approximate by watching for the Dock's "expose-frontmost" UI element appearing).
2. On activation, enumerate Spaces via `Cgs::copy_spaces`, intersect with `macos_space_labels` for the current `(machine_id, display_uuid)`, compute the screen-space frame of each thumbnail using a published-empirical layout function (`compute_thumbnail_frames(display, num_spaces)` with a unit-tested layout matching macOS 13/14/15).
3. Create one transparent borderless `NSWindow` per display (`level = NSScreenSaverWindowLevel + 1`, `collectionBehavior = canJoinAllSpaces | stationary | ignoresCycle`, `ignoresMouseEvents = true`). Each window draws labels via `NSAttributedString` over the precomputed frames.
4. On the next non-Mission-Control event (any focus change outside the Dock), hide the windows. They are reused, not re-created, on the next activation.

### Layout-function maintenance

The `compute_thumbnail_frames` function in `spaces/layout.rs` is the brittle part. v1 ships a layout matching macOS 15.2 (the test target). The implementation:

- Includes a snapshot test (`layout_macos_15_default.json`) generated from a real-screenshot fixture under `tests/fixtures/`.
- On startup, the driver verifies the layout function against the live `Cgs::copy_spaces` count. If the fixture-derived rect set doesn't match the live thumbnail count plus a sanity check against MC frame size, the driver downgrades — `capabilities` excludes `spaces`, `/health` reports `version_skew=true`, and the UI tells the user to update gctrl. There is **no fallback renderer**; we keep the failure mode loud rather than degrade silently.
- Documented as a known maintenance burden in `gctrl-driver-macos/README.md` so future contributors know to bump it on macOS major releases.

## Permissions Wiring

```rust
// permissions.rs
pub enum AxStatus { Granted, Denied, NotPromptable }

pub fn ax_status() -> AxStatus { /* AXIsProcessTrustedWithOptions(options=null) */ }
pub fn prompt_ax() -> AxStatus { /* AXIsProcessTrustedWithOptions(prompt=true)  */ }
```

When `/api/macos/health` returns `permissions.accessibility != "granted"` AND the user has tried to use Spaces, the Electron settings panel renders a CTA:

```
┌─────────────────────────────────────────────┐
│ Named Mission Control Spaces requires       │
│ Accessibility permission. Without it gctrl  │
│ cannot draw labels on top of Mission        │
│ Control.                                    │
│                                             │
│ [Grant Accessibility]                       │
└─────────────────────────────────────────────┘
```

`Grant Accessibility` → `POST /api/macos/permissions/accessibility/prompt` → driver triggers the system prompt → user grants → driver re-probes and re-registers `spaces` capability. There is no "skip" path; if the user dismisses the prompt the feature stays unavailable, the CTA stays visible, and the user can return to it later. Other gctrl features are unaffected — only the macOS Spaces panel is gated.

## Code Signing & Entitlements

The kernel sidecar is signed with the same Developer ID Application identity as the Electron `.app` (see [implementation/apps/desktop-electron.md § Sidecar Signing](../apps/desktop-electron.md#sidecar-signing)). `driver-macos` does NOT change that — it uses no extra entitlements.

The Electron `.app`'s `entitlements.mac.plist` already declares `com.apple.security.network.server` (kernel binds 127.0.0.1) and `com.apple.security.network.client`. **Accessibility access is granted at runtime by the user, not via entitlements** — there is no entitlement key for Accessibility. The driver's TCC entry is keyed on the kernel binary's bundle identifier (`dev.fractalbox.gctrl.kernel`), which is set in the kernel's `Info.plist` (added by the build pipeline; the standalone `gctrld` binary embeds an Info.plist via `lipo --create`).

For users running the kernel standalone (`brew install` route, no Electron), Accessibility is granted to the `gctrld` binary directly. The architecture spec's "v1 ship is via Electron" assumption simplifies this — Accessibility is asked once, in-context, when the user names their first Space.

## Build Pipeline

`apps/gctrl-desktop/scripts/build-kernel-universal.sh` is unchanged in shape — it already builds the workspace `--bin gctrld`. The new feature flag flows through:

```diff
 cargo zigbuild \
   --release \
   --workspace \
   --target "${TARGET}" \
+  --features "macos-platform" \
   --bin "gctrld"
```

Linux developer builds keep `cargo build --release --bin gctrld` without the feature, producing a kernel that returns `os: "linux", capabilities: []` from `/api/macos/health` (or 404; tbd) — confirming the cross-OS-portability invariant.

## Acceptance Test Plan

| Test | Where | Trigger |
|---|---|---|
| Unit — cold-index re-association after reorder | `gctrl-driver-macos/src/spaces/id.rs` | `cargo test -p gctrl-driver-macos` |
| Unit — layout fixture matches macOS 15 snapshot | `gctrl-driver-macos/src/spaces/layout.rs` | same |
| Unit — capability set excludes `spaces` when AX is denied | `gctrl-driver-macos/src/lib.rs` | same |
| Integration — `/api/macos/spaces` round-trip | `gctrl-driver-macos/tests/spaces_smoke.rs` | `cargo test -p gctrl-driver-macos --features integration-macos` (skipped in CI without a real macOS UI) |
| Acceptance — `gctrl-desktop` packaged app exposes the route | `apps/gctrl-desktop/tests/acceptance/macos-spaces.spec.ts` | follows the existing pattern from [`apps/gctrl-desktop`](../../../apps/gctrl-desktop/tests/acceptance/) — spawn `.app`, fetch `http://127.0.0.1:14318/api/macos/health`, assert `os == "macos"` and that `permissions.accessibility` is one of `granted`/`denied`/`not_requested` |
| Manual — Mission Control overlay renders | recorded in [Manual QA](#manual-qa--recipe) | named-Space label appears in Mission Control on macOS 13/14/15 |

The acceptance test under `apps/gctrl-desktop/tests/acceptance/` runs the same Playwright harness landed for [the desktop acceptance suite](../../../apps/gctrl-desktop/playwright.config.ts) and uses the existing `launchedApp` fixture; the only addition is a new `.spec.ts` file.

## v1 Ship Checklist

1. ☐ `gctrl-driver-macos` crate scaffolded; default build is a no-op stub
2. ☐ `PlatformPort` + `SpacesPort` traits in `gctrl-core`
3. ☐ DuckDB migration for `macos_space_labels` lands behind `gctrl-storage`'s migrator
4. ☐ `/api/macos/{health,spaces,...}` routes mounted in `gctrl-cli`'s axum tree behind `cfg(target_os="macos")`
5. ☐ AX permission probe + prompt route (`POST /api/macos/permissions/accessibility/prompt`)
6. ☐ AX overlay end-to-end working on macOS 15.x — label appears in Mission Control
7. ☐ Layout fixture + version-skew downgrade path tested
8. ☐ Permission CTA in `gctrl-board` settings panel
9. ☐ Cargo feature `macos-platform` on by default in the desktop release pipeline; off in `cargo build`
10. ☐ Acceptance test in `apps/gctrl-desktop/tests/acceptance/`
11. ☐ Manual QA recorded for macOS 13 + 14 + 15

## Manual QA — recipe

1. Build: `pnpm --filter gctrl-desktop test:acceptance:build`
2. Launch the packaged `.app` from `release/mac-arm64/gctrl.app`
3. In gctrl-board, go to Settings → macOS Spaces, click "Grant Accessibility", grant in System Settings
4. Name "Desktop 1" → `inbox`; "Desktop 2" → `code`
5. Activate Mission Control (`F3` or three-finger swipe up)
6. Confirm the labels `inbox` and `code` appear under the respective thumbnails
7. Drag windows between Spaces; labels remain on the original Spaces
8. Reboot; relaunch app; Mission Control shows the labels on the same indexed Spaces

## Known Trade-offs Carried Into v1

- **Accessibility is required.** No public-API path delivers the user-visible label without it; we surface the permission requirement clearly rather than ship a degraded fallback.
- **Layout-function brittleness.** macOS minor releases occasionally adjust thumbnail spacing. The driver's startup probe verifies the fixture against the live thumbnail count and downgrades capability rather than mis-rendering.
- **Per-display labelling only.** Labels are tied to `(display_uuid, index)`. Multi-display users who clamshell/undock will see labels rebind on display reconfiguration. Documented in the architecture spec.
- **No multi-Mac sync.** Deferred to a follow-up (label-by-role).

## Related

- [architecture/kernel/driver-macos.md](../../architecture/kernel/driver-macos.md) — the why, kernel interface, capability split
- [implementation/apps/desktop-electron.md](../apps/desktop-electron.md) — desktop bundling pipeline (consumes the kernel built here)
- [implementation/dogfood-drivers.md](../dogfood-drivers.md) — driver execution patterns (cache, OTel, secrets) the macOS driver inherits
