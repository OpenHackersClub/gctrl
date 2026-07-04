import { describe, expect, it } from "vitest"

import type { SidecarConfig } from "../kernel-sidecar"
import { augmentPath, buildKernelArgs } from "../spawner"

const baseConfig: SidecarConfig = {
  binPath: "/abs/gctrl-kernel",
  port: 4318,
  dataDir: "/abs/data",
}

describe("buildKernelArgs", () => {
  it("emits the canonical serve command with port, db file, and loopback host", () => {
    expect(buildKernelArgs(baseConfig)).toEqual([
      "serve",
      "--port",
      "4318",
      "--db",
      "/abs/data/gctrl.duckdb",
      "--host",
      "127.0.0.1",
    ])
  })

  it("appends --board-dir when vaultDir is configured", () => {
    const args = buildKernelArgs({ ...baseConfig, vaultDir: "/abs/vault" })
    const idx = args.indexOf("--board-dir")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe("/abs/vault")
  })

  it("omits --board-dir when vaultDir is not set", () => {
    expect(buildKernelArgs(baseConfig)).not.toContain("--board-dir")
  })

  it("always binds 127.0.0.1, never 0.0.0.0", () => {
    const args = buildKernelArgs({ ...baseConfig, port: 5555 })
    const hostIdx = args.indexOf("--host")
    expect(hostIdx).toBeGreaterThanOrEqual(0)
    expect(args[hostIdx + 1]).toBe("127.0.0.1")
  })

  it("derives the DB file inside the data dir", () => {
    const args = buildKernelArgs({ ...baseConfig, dataDir: "/tmp/gctrl" })
    const dbIdx = args.indexOf("--db")
    expect(dbIdx).toBeGreaterThanOrEqual(0)
    expect(args[dbIdx + 1]).toBe("/tmp/gctrl/gctrl.duckdb")
  })

  it("stringifies the port", () => {
    expect(buildKernelArgs({ ...baseConfig, port: 9999 })).toContain("9999")
  })
})

describe("augmentPath", () => {
  const HOME = "/Users/test"

  it("appends Homebrew + user CLI dirs to a bare LaunchServices PATH", () => {
    const result = augmentPath({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, HOME).split(":")
    expect(result).toContain("/opt/homebrew/bin")
    expect(result).toContain("/usr/local/bin")
    expect(result).toContain(`${HOME}/.local/bin`)
    expect(result).toContain(`${HOME}/.cargo/bin`)
  })

  it("preserves existing entries first (operator PATH wins)", () => {
    const result = augmentPath({ PATH: "/usr/bin:/bin" }, HOME).split(":")
    expect(result.slice(0, 2)).toEqual(["/usr/bin", "/bin"])
  })

  it("does not duplicate a dir already on PATH", () => {
    const result = augmentPath({ PATH: "/opt/homebrew/bin:/usr/bin" }, HOME).split(":")
    expect(result.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1)
  })

  it("handles an empty/unset PATH", () => {
    const result = augmentPath({}, HOME).split(":")
    expect(result).toContain("/opt/homebrew/bin")
    expect(result).not.toContain("")
  })
})
