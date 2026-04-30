import path from "node:path"
import { describe, expect, it } from "vitest"

import { type PathContext, resolveKernelBinPath, resolveKernelDataDir } from "../paths"

const packagedCtx: PathContext = {
  isPackaged: true,
  resourcesPath: "/Applications/gctrl.app/Contents/Resources",
  userDataPath: "/Users/alice/Library/Application Support/gctrl",
  appRoot: "/Applications/gctrl.app/Contents/Resources/app/main",
}

const devCtx: PathContext = {
  isPackaged: false,
  resourcesPath: "",
  userDataPath: "/Users/alice/Library/Application Support/Electron",
  appRoot: "/Users/alice/repo/apps/gctrl-desktop",
}

describe("resolveKernelBinPath", () => {
  it("packaged: points at the bundle's Resources/kernel/gctrl-kernel", () => {
    expect(resolveKernelBinPath(packagedCtx)).toBe(
      "/Applications/gctrl.app/Contents/Resources/kernel/gctrl-kernel",
    )
  })

  it("dev: defaults to the workspace's cargo release binary at ../../target/release/gctrl", () => {
    expect(resolveKernelBinPath(devCtx)).toBe(
      path.join("/Users/alice/repo/apps/gctrl-desktop", "..", "..", "target", "release", "gctrl"),
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
  it("returns <userDataPath>/kernel regardless of packaging", () => {
    expect(resolveKernelDataDir(packagedCtx)).toBe(
      "/Users/alice/Library/Application Support/gctrl/kernel",
    )
    expect(resolveKernelDataDir(devCtx)).toBe(
      "/Users/alice/Library/Application Support/Electron/kernel",
    )
  })
})
