import { describe, it, expect } from "vitest"
import { Effect, Either } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelError } from "../src/errors"
import { WranglerWhoami } from "../src/commands/wrangler"
import { createMockKernelClient } from "./helpers/mock-kernel"

const mockWhoami = {
  email: "dev@example.com",
  accounts: [
    { name: "Acme Labs", id: "abc123def456" },
    { name: "Personal", id: "9876543210fedcba" },
  ],
  raw: "decorated wrangler output",
}

const HealthyLayer = createMockKernelClient({
  "/api/wrangler/whoami": mockWhoami,
})

describe("gctrl wrangler whoami (via KernelClient)", () => {
  it("decodes email + accounts from kernel response", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/wrangler/whoami", WranglerWhoami)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(HealthyLayer))
    )

    expect(result.email).toBe("dev@example.com")
    expect(result.accounts.length).toBe(2)
    expect(result.accounts[0]).toEqual({ name: "Acme Labs", id: "abc123def456" })
    expect(result.accounts[1].id).toBe("9876543210fedcba")
    expect(result.raw).toBe("decorated wrangler output")
  })

  it("accepts null email (logged-out case)", async () => {
    const LoggedOut = createMockKernelClient({
      "/api/wrangler/whoami": { email: null, accounts: [], raw: "not authenticated" },
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/wrangler/whoami", WranglerWhoami)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(LoggedOut))
    )

    expect(result.email).toBeNull()
    expect(result.accounts.length).toBe(0)
  })

  it("surfaces KernelError when kernel route missing", async () => {
    const Empty = createMockKernelClient({})

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/wrangler/whoami", WranglerWhoami)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(Empty)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelError)
    }
  })
})
