import { describe, expect, it } from "vitest"

import type { SidecarConfig } from "../kernel-sidecar"
import { buildKernelArgs } from "../spawner"

const baseConfig: SidecarConfig = {
  binPath: "/abs/gctrl-kernel",
  port: 4318,
  dataDir: "/abs/data",
}

describe("buildKernelArgs", () => {
  it("emits the canonical serve command with port, data-dir, and loopback bind", () => {
    expect(buildKernelArgs(baseConfig)).toEqual([
      "serve",
      "--port",
      "4318",
      "--data-dir",
      "/abs/data",
      "--bind",
      "127.0.0.1",
    ])
  })

  it("always binds 127.0.0.1, never 0.0.0.0", () => {
    const args = buildKernelArgs({ ...baseConfig, port: 5555 })
    const bindIdx = args.indexOf("--bind")
    expect(bindIdx).toBeGreaterThanOrEqual(0)
    expect(args[bindIdx + 1]).toBe("127.0.0.1")
  })

  it("stringifies the port", () => {
    expect(buildKernelArgs({ ...baseConfig, port: 9999 })).toContain("9999")
  })
})
