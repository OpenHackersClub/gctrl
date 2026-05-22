// Path resolution for the kernel sidecar — pure module so the rules are
// testable without an Electron runtime. Production wiring fills in the
// `PathContext` from `app.isPackaged`, `process.resourcesPath`,
// `app.getPath("userData")`, `os.homedir()`, and `process.platform`.

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
   * `~/Library/Application Support/<electron-name>/`. The Electron-managed
   * vault directory lives under this path; the kernel DB does NOT (it
   * lives at the OS-native `gctrl/` data dir so terminal-launched `gctrld`
   * and the bundled sidecar share state).
   */
  readonly userDataPath: string
  /**
   * Path to `apps/gctrl-desktop/` for resolving dev-mode kernel binaries.
   * Required only when `isPackaged === false`.
   */
  readonly appRoot: string
  /**
   * `os.homedir()`. Drives the OS-native data-dir resolution shared with
   * the standalone `gctrld` CLI (see `resolveKernelDataDir`).
   */
  readonly homedir: string
  /**
   * `process.platform`. Selects the per-OS data dir convention — macOS
   * uses `~/Library/Application Support/`, everything else uses XDG.
   */
  readonly platform: NodeJS.Platform
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
 * Packaged: `<resourcesPath>/kernel/gctrl-kernel` — renamed from `gctrld`
 * by the `build-kernel-universal.sh` script so the consumer doesn't have
 * to know about the daemon `d`-suffix convention.
 * Dev (override): the `devKernelPath` value verbatim.
 * Dev (default): `<appRoot>/../../target/release/gctrld` — the workspace's
 * cargo release binary as produced by `cargo build --bin gctrld`.
 */
export const resolveKernelBinPath = (ctx: PathContext): string => {
  if (ctx.isPackaged) {
    return path.join(ctx.resourcesPath, "kernel", "gctrl-kernel")
  }
  if (ctx.devKernelPath) {
    return ctx.devKernelPath
  }
  return path.join(ctx.appRoot, "..", "..", "target", "release", "gctrld")
}

/**
 * Resolve the kernel data directory. **Shared with the standalone `gctrld`
 * CLI** so terminal-launched and Dock-launched kernels see the same DB.
 * Historically the sidecar wrote to `<userData>/kernel/` while the CLI
 * defaulted to `~/.local/share/gctrl/`, so projects created by one were
 * invisible to the other.
 *
 * Per-OS native location (mirrors `gctrl-core::config::gctrl_data_dir`):
 * - macOS:        `~/Library/Application Support/gctrl/`
 * - Linux/other:  `~/.local/share/gctrl/`
 *
 * Independent of packaging — dev and packaged sidecars both land at the
 * same per-host dir, which is the whole point.
 */
export const resolveKernelDataDir = (ctx: PathContext): string => {
  const nativeParent =
    ctx.platform === "darwin"
      ? path.join(ctx.homedir, "Library", "Application Support")
      : path.join(ctx.homedir, ".local", "share")
  return path.join(nativeParent, "gctrl")
}

/**
 * Resolve the default vault directory the kernel sidecar should watch.
 *
 * Layout under this root follows the existing kernel convention — one
 * subdirectory per project key holding `*.md` files (e.g. `vault/BOARD/BOARD-1.md`,
 * `vault/INBOX/INBOX-1.md`). The kernel auto-registers a `default`
 * `gctrl_vault_mounts` row at this path on first boot when the table is
 * empty so the file watcher starts indexing immediately.
 *
 * Always `<userDataPath>/vault/`; operators who want to watch an existing
 * Obsidian vault elsewhere can override at the kernel level via
 * `GCTRL_BOARD_DIR` (consumed by the bundled binary directly).
 */
export const resolveKernelVaultDir = (ctx: PathContext): string =>
  path.join(ctx.userDataPath, "vault")
