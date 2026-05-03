/**
 * `gctrl app install/list/status/reload/uninstall` tests.
 *
 * Verifies the shell wraps /api/app/* correctly via mocked KernelClient.
 * The Rust kernel side is tested separately under
 * kernel/crates/gctrl-otel/src/receiver.rs (PR-α.3).
 */
import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

// --- schemas (mirroring src/commands/app.ts) ---

const AppInstall = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  source_ref: Schema.String,
  manifest_sha: Schema.String,
  installed_at: Schema.String,
  reloaded_at: Schema.NullOr(Schema.String),
})

const AppBinding = Schema.Struct({
  install_name: Schema.String,
  capability: Schema.String,
  driver_id: Schema.String,
  required: Schema.Boolean,
  resolved_at: Schema.String,
})

const VaultMount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root_path: Schema.String,
  kind: Schema.String,
  app_id: Schema.NullOr(Schema.String),
})

const AppInstallView = Schema.Struct({
  install: AppInstall,
  bindings: Schema.Array(AppBinding),
  vault_mounts: Schema.Array(VaultMount),
})

const AppInstallList = Schema.Array(AppInstall)

const Capability = Schema.Struct({
  id: Schema.String,
  default_driver: Schema.String,
  route_prefix: Schema.String,
  description: Schema.String,
})
const CapabilityList = Schema.Array(Capability)

// --- fixtures ---

const installRow = {
  name: "uebermensch",
  version: "0.2.0",
  source_ref: "/path/to/uebermensch/gctrl-app.toml",
  manifest_sha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  installed_at: "2026-05-03T12:00:00Z",
  reloaded_at: null,
}

const installRowReloaded = {
  ...installRow,
  version: "0.3.0",
  reloaded_at: "2026-05-03T13:00:00Z",
}

const bindings = [
  {
    install_name: "uebermensch",
    capability: "deliverer.telegram",
    driver_id: "driver-telegram",
    required: true,
    resolved_at: "2026-05-03T12:00:00Z",
  },
  {
    install_name: "uebermensch",
    capability: "llm",
    driver_id: "driver-llm",
    required: true,
    resolved_at: "2026-05-03T12:00:00Z",
  },
  {
    install_name: "uebermensch",
    capability: "gcal",
    driver_id: "driver-gcal",
    required: false,
    resolved_at: "2026-05-03T12:00:00Z",
  },
]

const vaultMounts = [
  {
    id: "mount-uuid",
    name: "UBER",
    root_path: "UBER",
    kind: "app",
    app_id: "uebermensch",
  },
]

const installView = {
  install: installRow,
  bindings,
  vault_mounts: vaultMounts,
}

const reloadedView = {
  install: installRowReloaded,
  bindings,
  vault_mounts: vaultMounts,
}

const capabilities = [
  {
    id: "llm",
    default_driver: "driver-llm",
    route_prefix: "/api/llm",
    description: "LLM relay",
  },
  {
    id: "deliverer.telegram",
    default_driver: "driver-telegram",
    route_prefix: "/api/telegram",
    description: "Telegram",
  },
]

// --- mock layer ---

const MockLayer = createMockKernelClient(
  {
    "/api/app/installs": [installRow],
    "/api/app/installs/uebermensch": installView,
    "/api/app/capabilities": capabilities,
  },
  {
    "/api/app/installs": installView,
    "/api/app/installs/uebermensch/reload": reloadedView,
  },
)

const EmptyLayer = createMockKernelClient(
  {
    "/api/app/installs": [],
    "/api/app/capabilities": capabilities,
  },
  {},
)

describe("gctrl app install/list/status/reload/uninstall (via KernelClient)", () => {
  it("install returns the AppInstallView with bindings + mounts", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/app/installs",
        { source_ref: "/path/to/manifest.toml", manifest_text: "[app]\nname = ..." },
        AppInstallView,
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.install.name).toBe("uebermensch")
    expect(result.install.version).toBe("0.2.0")
    expect(result.bindings).toHaveLength(3)
    expect(result.bindings.find((b) => b.capability === "llm")?.driver_id).toBe("driver-llm")
    expect(result.vault_mounts[0].name).toBe("UBER")
    expect(result.vault_mounts[0].app_id).toBe("uebermensch")
  })

  it("list returns AppInstall array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/app/installs", AppInstallList)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("uebermensch")
  })

  it("list on empty kernel returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/app/installs", AppInstallList)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyLayer)))
    expect(result).toEqual([])
  })

  it("status returns the full view for a known install", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/app/installs/uebermensch", AppInstallView)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.install.name).toBe("uebermensch")
    expect(result.bindings.find((b) => b.capability === "gcal")?.required).toBe(false)
    expect(result.bindings.find((b) => b.capability === "llm")?.required).toBe(true)
  })

  it("reload returns view with reloaded_at populated and bumped version", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/app/installs/uebermensch/reload",
        { source_ref: "/path/to/manifest.toml", manifest_text: "[app]\nname = ..." },
        AppInstallView,
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.install.version).toBe("0.3.0")
    expect(result.install.reloaded_at).toBe("2026-05-03T13:00:00Z")
  })

  it("uninstall succeeds (delete returns void)", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/app/installs/uebermensch")
      return "ok"
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toBe("ok")
  })

  it("capabilities returns the registry list", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/app/capabilities", CapabilityList)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.id)).toEqual(["llm", "deliverer.telegram"])
    expect(result[0].route_prefix).toBe("/api/llm")
  })

  it("status on unknown app surfaces a KernelError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/app/installs/never-installed", AppInstallView)
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(EmptyLayer)))
    expect(exit._tag).toBe("Failure")
  })
})
