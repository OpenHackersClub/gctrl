import { describe, it, expect } from "vitest"
import { Effect, Either, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

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

const MockLayer = createMockKernelClient({
  "/api/sessions": mockSessions,
  "/api/analytics": mockAnalytics,
}, {}, {
  "/api/context/test-1/content": "# Hello World\nThis is test content.",
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
      program.pipe(Effect.provide(MockLayer))
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
      program.pipe(Effect.provide(MockLayer))
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
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result.total_sessions).toBe(42)
    expect(result.total_cost_usd).toBe(12.5)
  })

  it("mock layer returns text content", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/test-1/content")
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toContain("Hello World")
  })

  it("mock layer returns 404 for unknown paths", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/unknown", Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
  })
})
