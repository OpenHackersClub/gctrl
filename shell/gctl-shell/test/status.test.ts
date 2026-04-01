import { describe, it, expect } from "vitest"
import { Effect, Either, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelUnavailableError } from "../src/errors"
import { createMockKernelClient, createMockUnhealthyKernelClient } from "./helpers/mock-kernel"

const mockAnalytics = {
  total_sessions: 42,
  active_sessions: 3,
  total_spans: 1580,
  total_cost_usd: 12.5,
}

const HealthyLayer = createMockKernelClient({
  "/api/analytics": mockAnalytics,
})

const UnhealthyLayer = createMockUnhealthyKernelClient()

const Analytics = Schema.Struct({
  total_sessions: Schema.Number,
  active_sessions: Schema.Number,
  total_spans: Schema.Number,
  total_cost_usd: Schema.Number,
})

describe("Status command logic (via KernelClient)", () => {
  it("healthy kernel returns true from health()", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.health()
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(HealthyLayer))
    )

    expect(result).toBe(true)
  })

  it("healthy kernel can fetch analytics", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const healthy = yield* kernel.health()
      expect(healthy).toBe(true)
      return yield* kernel.get("/api/analytics", Analytics)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(HealthyLayer))
    )

    expect(result.total_sessions).toBe(42)
    expect(result.active_sessions).toBe(3)
  })

  it("unhealthy kernel health() fails with KernelUnavailableError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.health()
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(UnhealthyLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelUnavailableError)
    }
  })

  it("status logic: healthy path shows analytics", async () => {
    // Simulates the status command's logic
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const healthy = yield* kernel.health()
      if (!healthy) return { online: false, analytics: null }

      const analytics = yield* kernel.get("/api/analytics", Analytics).pipe(
        Effect.catchTag("KernelError", () => Effect.succeed(null))
      )
      return { online: true, analytics }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(HealthyLayer))
    )

    expect(result.online).toBe(true)
    expect(result.analytics).not.toBeNull()
    expect(result.analytics!.total_sessions).toBe(42)
  })

  it("status logic: unhealthy path catches error gracefully", async () => {
    // Simulates the status command handling an offline kernel
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const healthy = yield* kernel.health().pipe(
        Effect.catchTag("KernelUnavailableError", () => Effect.succeed(false))
      )
      if (!healthy) return { online: false, analytics: null }

      const analytics = yield* kernel.get("/api/analytics", Analytics)
      return { online: true, analytics }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(UnhealthyLayer))
    )

    expect(result.online).toBe(false)
    expect(result.analytics).toBeNull()
  })

  it("status logic: healthy kernel but analytics fails returns online with null analytics", async () => {
    // Kernel is online but /api/analytics returns 404
    const OnlineNoAnalytics = createMockKernelClient({})

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const healthy = yield* kernel.health()
      if (!healthy) return { online: false, analytics: null }

      const analytics = yield* kernel.get("/api/analytics", Analytics).pipe(
        Effect.catchTag("KernelError", () => Effect.succeed(null)),
        Effect.catchTag("KernelUnavailableError", () => Effect.succeed(null))
      )
      return { online: true, analytics }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(OnlineNoAnalytics))
    )

    expect(result.online).toBe(true)
    expect(result.analytics).toBeNull()
  })
})
