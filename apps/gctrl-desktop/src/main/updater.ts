// Auto-update wiring around `electron-updater`.
//
// The decision logic (when to check, how to schedule, what to log) is split
// from the side-effecting calls so it can be unit-tested without a real
// Squirrel manifest or network access. `startAutoUpdater` takes its
// dependencies via a port and ignores everything in dev mode.

import type { SidecarLogger } from "./kernel-sidecar"

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

export type UpdaterDeps = {
  /** True when running from a packaged `.app` bundle. */
  readonly isPackaged: boolean
  /** Triggers a check-and-download against the configured update feed. */
  readonly checkForUpdates: () => Promise<void>
  /** Periodic-check scheduler — wraps `setInterval` for testability. */
  readonly setInterval: (fn: () => void, ms: number) => unknown
  readonly logger?: SidecarLogger
}

const noopLogger: SidecarLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Begin auto-update polling. In dev mode this is a no-op so contributors
 * never accidentally chase a release feed during local work.
 *
 * Schedule: one check on startup, then every {@link UPDATE_CHECK_INTERVAL_MS}.
 * Errors are logged and swallowed — a failed update check must never crash
 * the app or surface UI to the user. `electron-updater` will retry on the
 * next interval.
 */
export const startAutoUpdater = (deps: UpdaterDeps): void => {
  const logger = deps.logger ?? noopLogger

  if (!deps.isPackaged) {
    logger.info("auto-updater: skipping — running from source (not packaged)")
    return
  }

  const tick = () => {
    deps.checkForUpdates().catch((err: unknown) => {
      logger.error(`auto-updater: check failed — ${String(err)}`)
    })
  }

  // Initial check shortly after launch.
  tick()
  // Periodic re-check.
  deps.setInterval(tick, UPDATE_CHECK_INTERVAL_MS)
}
