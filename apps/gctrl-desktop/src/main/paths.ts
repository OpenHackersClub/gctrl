// Path resolution for the kernel sidecar — pure module so the rules are
// testable without an Electron runtime. Production wiring fills in the
// `PathContext` from `app.isPackaged`, `process.resourcesPath`, and
// `app.getPath("userData")`.

import path from "node:path"

export type PathContext = {
  /** Whether the Electron app is running from a packaged `.app` bundle. */
  readonly isPackaged: boolean
  /**
   * `process.resourcesPath` when packaged. In a packaged macOS bundle this is
   * `<App>.app/Contents/Resources/`. Bundled `extraResources` (the kernel
   * binary) live under this directory.
   */
  readonly resourcesPath: string
  /**
   * `app.getPath("userData")`. On macOS this is
   * `~/Library/Application Support/<bundle-id>/`. The kernel's DuckDB and
   * vault directory live under this path.
   */
  readonly userDataPath: string
  /**
   * Path to `apps/gctrl-desktop/` for resolving dev-mode kernel binaries.
   * Required only when `isPackaged === false`.
   */
  readonly appRoot: string
  /**
   * Optional override for the dev-mode kernel binary. When set, takes
   * precedence over the default dev-mode lookup. Wire to env var
   * `GCTRL_KERNEL_DEV_PATH` so contributors can point at any local build.
   */
  readonly devKernelPath?: string
}

/**
 * Resolve the absolute path to the bundled kernel binary.
 *
 * Packaged: `<resourcesPath>/kernel/gctrl-kernel`.
 * Dev (override): the `devKernelPath` value verbatim.
 * Dev (default): `<appRoot>/../../target/release/gctrl` — the workspace's
 * cargo release binary.
 */
export const resolveKernelBinPath = (ctx: PathContext): string => {
  if (ctx.isPackaged) {
    return path.join(ctx.resourcesPath, "kernel", "gctrl-kernel")
  }
  if (ctx.devKernelPath) {
    return ctx.devKernelPath
  }
  return path.join(ctx.appRoot, "..", "..", "target", "release", "gctrl")
}

/**
 * Resolve the kernel data directory. Independent of packaging — always
 * `<userDataPath>/kernel/`. This directory survives app uninstall.
 */
export const resolveKernelDataDir = (ctx: PathContext): string =>
  path.join(ctx.userDataPath, "kernel")
