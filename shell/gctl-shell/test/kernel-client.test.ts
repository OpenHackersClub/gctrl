import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { KernelError, KernelUnavailableError } from "../src/errors.js"

/**
 * Mock KernelClient layer for testing shell commands
 * without a running kernel daemon.
 */
const mockSessions = [
  {
    id: "sess-001",
    agent_name: "Claude Code",
    status: "active",
    started_at: "2026-03-30T10:00:00Z",
    total_cost_usd: 0.0512,
    total_input_tokens: 15000,
    total_output_tokens: 3000,
  },
  {
    id: "sess-002",
    agent_name: "Codex",
    status: "completed",
    started_at: "2026-03-30T09:00:00Z",
    total_cost_usd: 0.12,
    total_input_tokens: 40000,
    total_output_tokens: 8000,
  },
]

const mockAnalytics = {
  total_sessions: 42,
  active_sessions: 3,
  total_spans: 1580,
  total_cost_usd: 12.5,
}

const MockKernelClientLive = Layer.succeed(KernelClient, {
  get: (path, schema) =>
    Effect.gen(function* () {
      if (path.startsWith("/api/sessions")) {
        return yield* Schema.decodeUnknown(schema)(mockSessions)
      }
      if (path === "/api/analytics") {
        return yield* Schema.decodeUnknown(schema)(mockAnalytics)
      }
      return yield* Effect.fail(
        new KernelError({ message: `Not found: ${path}`, statusCode: 404 })
      )
    }),

  post: (_path, _body, schema) =>
    Effect.fail(new KernelError({ message: "Not implemented in mock" })),

  delete: (_path) =>
    Effect.fail(new KernelError({ message: "Not implemented in mock" })),

  health: () => Effect.succeed(true),
})

describe("KernelClient port", () => {
  it("mock layer returns sessions", async () => {
    const SessionList = Schema.Array(
      Schema.Struct({
        id: Schema.String,
        agent_name: Schema.String,
        status: Schema.String,
        started_at: Schema.String,
        total_cost_usd: Schema.Number,
        total_input_tokens: Schema.Number,
        total_output_tokens: Schema.Number,
      })
    )

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions?limit=20", SessionList)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockKernelClientLive))
    )

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("sess-001")
    expect(result[0].agent_name).toBe("Claude Code")
    expect(result[1].status).toBe("completed")
  })

  it("mock layer returns health", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.health()
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockKernelClientLive))
    )

    expect(result).toBe(true)
  })

  it("mock layer returns analytics", async () => {
    const AnalyticsSchema = Schema.Struct({
      total_sessions: Schema.Number,
      active_sessions: Schema.Number,
      total_spans: Schema.Number,
      total_cost_usd: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics", AnalyticsSchema)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockKernelClientLive))
    )

    expect(result.total_sessions).toBe(42)
    expect(result.total_cost_usd).toBe(12.5)
  })
})
