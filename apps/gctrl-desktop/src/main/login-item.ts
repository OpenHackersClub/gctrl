// Register the .app as a macOS Login Item so `gctrld` is up before any
// `gctrl://` click, terminal `gctrl` invocation, or scheduled job tries to
// reach `:4318`. Replaces the previous `dev.gctrl.kernel.plist` LaunchAgent
// install — autostart now ships with the desktop bundle, with the kernel
// running as the .app's sidecar (subject to the singleton check in
// `kernel-sidecar.ts`).
//
// First-launch only: we register exactly once per install. If the user later
// unticks gctrl in System Settings → General → Login Items, we MUST NOT
// silently re-enable on the next launch — that's user-hostile. The marker
// file under `userData/` records that we've done our one-time registration.
//
// Pure decision logic + injected ports keep this unit-testable without
// touching Electron, the filesystem, or System Settings.

export type LoginItemSettings = {
  readonly openAtLogin: boolean
  readonly openAsHidden?: boolean
}

export type LoginItemPorts = {
  readonly isPackaged: boolean
  readonly markerExists: () => boolean
  readonly writeMarker: () => void
  readonly getCurrent: () => LoginItemSettings
  readonly set: (settings: LoginItemSettings) => void
  readonly logger?: {
    info(message: string): void
    warn(message: string): void
  }
}

export type LoginItemOutcome =
  | "registered"
  | "skipped-not-packaged"
  | "skipped-already-registered"
  | "skipped-marker-present"

/**
 * Idempotent first-launch Login Item registration. Returns the path taken so
 * tests can assert behavior without inspecting side effects.
 *
 * - `skipped-not-packaged` — dev mode (`pnpm dev`); contributors don't want
 *   their `.app` autostarted from a debug session.
 * - `skipped-already-registered` — Electron reports `openAtLogin: true`
 *   already. Could be a prior `set()` from us, or the user manually enabled
 *   it. Either way, no work to do; we still write the marker so future
 *   launches recognize the install as initialized.
 * - `skipped-marker-present` — we've registered before. The user may have
 *   subsequently disabled it; respect that and don't override.
 * - `registered` — first packaged launch, no marker, not currently set →
 *   enable + write marker.
 */
export const ensureLoginItemRegistered = (ports: LoginItemPorts): LoginItemOutcome => {
  if (!ports.isPackaged) return "skipped-not-packaged"

  if (ports.markerExists()) return "skipped-marker-present"

  if (ports.getCurrent().openAtLogin) {
    // User (or a previous install we don't have a marker for) already enabled
    // it. Drop a marker so we don't try again next launch.
    ports.writeMarker()
    ports.logger?.info("login item already enabled — recorded marker, no change")
    return "skipped-already-registered"
  }

  ports.set({ openAtLogin: true, openAsHidden: false })
  ports.writeMarker()
  ports.logger?.info("registered .app as macOS Login Item (first-launch only)")
  return "registered"
}
