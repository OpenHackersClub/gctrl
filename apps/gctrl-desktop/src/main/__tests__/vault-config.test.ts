import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  readVaultConfig,
  resolveVaultDir,
  VAULT_CONFIG_FILENAME,
  writeVaultConfig,
} from "../vault-config"

const silentLogger = { info: () => {}, warn: () => {} }

let userData: string

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "vault-config-test-"))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe("resolveVaultDir resolution order", () => {
  it("GCTRL_BOARD_DIR env wins over everything (and is NOT persisted)", async () => {
    writeVaultConfig(userData, {
      vaultPath: "/persisted/path",
      configuredAt: "2026-05-01T00:00:00Z",
    })
    const picker = vi.fn().mockResolvedValue("/picker/path")

    const result = await resolveVaultDir({
      userDataPath: userData,
      defaultVaultDir: "/default/path",
      envOverride: "/env/path",
      picker,
      logger: silentLogger,
    })

    expect(result).toBe("/env/path")
    expect(picker).not.toHaveBeenCalled()

    // Persisted config from the test setup must NOT have been overwritten
    // — env values are ephemeral by design.
    expect(readVaultConfig(userData)?.vaultPath).toBe("/persisted/path")
  })

  it("persisted config wins when env is unset", async () => {
    writeVaultConfig(userData, {
      vaultPath: "/persisted/path",
      configuredAt: "2026-05-01T00:00:00Z",
    })
    const picker = vi.fn()

    const result = await resolveVaultDir({
      userDataPath: userData,
      defaultVaultDir: "/default/path",
      envOverride: undefined,
      picker,
      logger: silentLogger,
    })

    expect(result).toBe("/persisted/path")
    expect(picker).not.toHaveBeenCalled()
  })

  it("invokes the picker when neither env nor persisted is present", async () => {
    const picker = vi.fn().mockResolvedValue("/picker/path")

    const result = await resolveVaultDir({
      userDataPath: userData,
      defaultVaultDir: "/default/path",
      envOverride: undefined,
      picker,
      logger: silentLogger,
    })

    expect(result).toBe("/picker/path")
    expect(picker).toHaveBeenCalledTimes(1)

    // First-time picker choice MUST persist so the second launch skips the dialog.
    expect(readVaultConfig(userData)?.vaultPath).toBe("/picker/path")
  })

  it("falls back to default (without persisting) when the user cancels the picker", async () => {
    const picker = vi.fn().mockResolvedValue(null)

    const result = await resolveVaultDir({
      userDataPath: userData,
      defaultVaultDir: "/default/path",
      envOverride: undefined,
      picker,
      logger: silentLogger,
    })

    expect(result).toBe("/default/path")
    // Cancel MUST NOT persist — otherwise we'd silently lock the user into
    // the empty default forever. Next launch should ask again.
    expect(readVaultConfig(userData)).toBeNull()
  })

  it("treats whitespace-only GCTRL_BOARD_DIR as unset", async () => {
    const picker = vi.fn().mockResolvedValue("/picker/path")

    const result = await resolveVaultDir({
      userDataPath: userData,
      defaultVaultDir: "/default/path",
      envOverride: "   ",
      picker,
      logger: silentLogger,
    })

    expect(result).toBe("/picker/path")
    expect(picker).toHaveBeenCalled()
  })
})

describe("vault-config file persistence", () => {
  it("round-trips through write + read", () => {
    const cfg = { vaultPath: "/some/vault", configuredAt: "2026-05-23T03:00:00Z" }
    writeVaultConfig(userData, cfg)
    expect(readVaultConfig(userData)).toEqual(cfg)
  })

  it("returns null when the config file is absent", () => {
    expect(readVaultConfig(userData)).toBeNull()
  })

  it("returns null on malformed JSON (so the picker re-prompts instead of crashing)", () => {
    writeFileSync(path.join(userData, VAULT_CONFIG_FILENAME), "{not-json}", "utf8")
    expect(readVaultConfig(userData)).toBeNull()
  })

  it("returns null when vaultPath is missing or empty", () => {
    writeFileSync(
      path.join(userData, VAULT_CONFIG_FILENAME),
      JSON.stringify({ vaultPath: "" }),
      "utf8",
    )
    expect(readVaultConfig(userData)).toBeNull()
  })

  it("creates the userData directory if it doesn't exist yet", () => {
    const fresh = path.join(userData, "nested", "userdata")
    writeVaultConfig(fresh, {
      vaultPath: "/x",
      configuredAt: "2026-05-23T03:00:00Z",
    })
    expect(readVaultConfig(fresh)?.vaultPath).toBe("/x")
  })
})
