import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  type PathContext,
  resolveKernelBinPath,
  resolveKernelDataDir,
  resolveKernelVaultDir,
} from "../paths"

// `userDataPath` reflects what Electron actually returns from
// `app.getPath("userData")` — keyed by the Electron app name
// (`gctrl-desktop`), NOT the bundle id. The CLI default lives one level
// up (`Application Support/gctrl/`), so the two must NOT be equal —
// historically they did diverge, and that divergence was the bug.
const packagedCtx: PathContext = {
  isPackaged: true,
  resourcesPath: "/Applications/gctrl.app/Contents/Resources",
  userDataPath: "/Users/alice/Library/Application Support/gctrl-desktop",
  appRoot: "/Applications/gctrl.app/Contents/Resources/app/main",
  homedir: "/Users/alice",
  platform: "darwin",
}

const devCtx: PathContext = {
  isPackaged: false,
  resourcesPath: "",
  userDataPath: "/Users/alice/Library/Application Support/Electron",
  appRoot: "/Users/alice/repo/apps/gctrl-desktop",
  homedir: "/Users/alice",
  platform: "darwin",
}

const linuxCtx: PathContext = {
  isPackaged: true,
  resourcesPath: "/opt/gctrl/resources",
  userDataPath: "/home/alice/.config/gctrl",
  appRoot: "/opt/gctrl/resources/app/main",
  homedir: "/home/alice",
  platform: "linux",
}

describe("resolveKernelBinPath", () => {
  it("packaged: points at the bundle's Resources/kernel/gctrl-kernel", () => {
    expect(resolveKernelBinPath(packagedCtx)).toBe(
      "/Applications/gctrl.app/Contents/Resources/kernel/gctrl-kernel",
    )
  })

  it("dev: defaults to the workspace's cargo release binary at ../../target/release/gctrld", () => {
    expect(resolveKernelBinPath(devCtx)).toBe(
      path.join("/Users/alice/repo/apps/gctrl-desktop", "..", "..", "target", "release", "gctrld"),
    )
  })

  it("dev with override: returns devKernelPath verbatim, ignoring the default", () => {
    const ctx: PathContext = { ...devCtx, devKernelPath: "/custom/path/to/my-gctrl" }
    expect(resolveKernelBinPath(ctx)).toBe("/custom/path/to/my-gctrl")
  })

  it("packaged with override: ignores devKernelPath because override is dev-only", () => {
    const ctx: PathContext = { ...packagedCtx, devKernelPath: "/this/should/be/ignored" }
    expect(resolveKernelBinPath(ctx)).toBe(
      "/Applications/gctrl.app/Contents/Resources/kernel/gctrl-kernel",
    )
  })
})

describe("resolveKernelDataDir", () => {
  it("macOS: returns ~/Library/Application Support/gctrl (matches gctrld CLI default)", () => {
    expect(resolveKernelDataDir(packagedCtx)).toBe(
      "/Users/alice/Library/Application Support/gctrl",
    )
    // Dev mode (different userDataPath but same homedir+platform) MUST
    // resolve to the same dir as packaged — sharing state with the CLI is
    // the whole point, and divergence here was the original bug.
    expect(resolveKernelDataDir(devCtx)).toBe(
      "/Users/alice/Library/Application Support/gctrl",
    )
  })

  it("Linux: returns ~/.local/share/gctrl (XDG)", () => {
    expect(resolveKernelDataDir(linuxCtx)).toBe("/home/alice/.local/share/gctrl")
  })

  it("ignores userDataPath — does NOT live under Electron's per-app dir", () => {
    // userDataPath is platform-dependent and uses the Electron app name;
    // anchoring kernel state there would diverge from the CLI default.
    expect(resolveKernelDataDir(packagedCtx)).not.toContain(packagedCtx.userDataPath)
  })
})

describe("resolveKernelVaultDir", () => {
  it("returns <userDataPath>/vault regardless of packaging", () => {
    expect(resolveKernelVaultDir(packagedCtx)).toBe(
      "/Users/alice/Library/Application Support/gctrl-desktop/vault",
    )
    expect(resolveKernelVaultDir(devCtx)).toBe(
      "/Users/alice/Library/Application Support/Electron/vault",
    )
  })

  it("never collides with the kernel data dir (kept on a sibling path)", () => {
    expect(resolveKernelVaultDir(packagedCtx)).not.toBe(resolveKernelDataDir(packagedCtx))
  })
})
