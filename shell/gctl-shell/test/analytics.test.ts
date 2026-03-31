import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { createMockKernelClient } from "./helpers/mock-kernel.js"

const mockAnalytics = {
  total_sessions: 42,
  active_sessions: 3,
  total_spans: 1580,
  total_cost_usd: 12.5,
}

const mockCost = {
  by_model: [
    { model: "claude-opus-4", cost: 8.2, calls: 150 },
    { model: "claude-sonnet-4", cost: 4.3, calls: 300 },
  ],
  by_agent: [
    { agent: "Claude Code", cost: 10.5, sessions: 30 },
    { agent: "Codex", cost: 2.0, sessions: 12 },
  ],
}

const mockLatency = {
  by_model: [
    { model: "claude-opus-4", p50_ms: 1200, p95_ms: 3500, p99_ms: 8000 },
  ],
}

const mockSpans = {
  distribution: [
    { span_type: "llm", count: 800, percentage: 50.6 },
    { span_type: "tool", count: 600, percentage: 38.0 },
    { span_type: "agent", count: 180, percentage: 11.4 },
  ],
}

const mockScores = {
  name: "quality",
  pass: 35,
  fail: 7,
  total: 42,
  pass_rate: 0.833,
  avg_value: 0.78,
}

const mockDaily = [
  { date: "2026-03-30", sessions: 15, spans: 450, cost_usd: 3.2 },
  { date: "2026-03-29", sessions: 12, spans: 380, cost_usd: 2.8 },
]

const mockAlerts = [
  { id: "a-1", name: "High cost", condition_type: "cost_threshold", threshold: 50.0, action: "log", enabled: true },
]

const MockLayer = createMockKernelClient(
  {
    "/api/analytics": mockAnalytics,
    "/api/analytics/cost": mockCost,
    "/api/analytics/latency": mockLatency,
    "/api/analytics/spans": mockSpans,
    "/api/analytics/scores": mockScores,
    "/api/analytics/daily": mockDaily,
    "/api/analytics/alerts": mockAlerts,
  },
  {
    "/api/analytics/score": { id: "score-001" },
    "/api/analytics/tag": { id: "tag-001" },
  }
)

describe("Analytics commands (via KernelClient)", () => {
  it("overview returns totals", async () => {
    const AnalyticsOverview = Schema.Struct({
      total_sessions: Schema.Number,
      active_sessions: Schema.Number,
      total_spans: Schema.Number,
      total_cost_usd: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics", AnalyticsOverview)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.total_sessions).toBe(42)
    expect(result.total_cost_usd).toBe(12.5)
  })

  it("cost returns by_model and by_agent", async () => {
    const CostAnalytics = Schema.Struct({
      by_model: Schema.Array(Schema.Struct({ model: Schema.String, cost: Schema.Number, calls: Schema.Number })),
      by_agent: Schema.Array(Schema.Struct({ agent: Schema.String, cost: Schema.Number, sessions: Schema.Number })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/cost", CostAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.by_model).toHaveLength(2)
    expect(result.by_model[0].model).toBe("claude-opus-4")
    expect(result.by_agent[0].agent).toBe("Claude Code")
  })

  it("latency returns percentiles", async () => {
    const LatencyAnalytics = Schema.Struct({
      by_model: Schema.Array(Schema.Struct({ model: Schema.String, p50_ms: Schema.Number, p95_ms: Schema.Number, p99_ms: Schema.Number })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/latency", LatencyAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.by_model[0].p50_ms).toBe(1200)
  })

  it("spans returns distribution", async () => {
    const SpanAnalytics = Schema.Struct({
      distribution: Schema.Array(Schema.Struct({ span_type: Schema.optional(Schema.String), count: Schema.Number, percentage: Schema.Number })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/spans", SpanAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.distribution).toHaveLength(3)
    expect(result.distribution[0].count).toBe(800)
  })

  it("scores returns pass/fail breakdown", async () => {
    const ScoreAnalytics = Schema.Struct({
      name: Schema.String,
      pass: Schema.Number,
      fail: Schema.Number,
      total: Schema.Number,
      pass_rate: Schema.Number,
      avg_value: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/scores?name=quality", ScoreAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.name).toBe("quality")
    expect(result.total).toBe(42)
    expect(result.pass_rate).toBeCloseTo(0.833)
  })

  it("daily returns time series", async () => {
    const DailyAnalytics = Schema.Array(Schema.Struct({
      date: Schema.String,
      sessions: Schema.Number,
      spans: Schema.Number,
      cost_usd: Schema.Number,
    }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/daily?days=7", DailyAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe("2026-03-30")
  })

  it("score creation returns id", async () => {
    const ScoreCreated = Schema.Struct({ id: Schema.String })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/analytics/score", {
        target_type: "session",
        target_id: "sess-001",
        name: "quality",
        value: 0.9,
        source: "human",
      }, ScoreCreated)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("score-001")
  })

  it("tag creation returns id", async () => {
    const TagCreated = Schema.Struct({ id: Schema.String })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/analytics/tag", {
        target_type: "session",
        target_id: "sess-001",
        key: "env",
        value: "prod",
      }, TagCreated)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("tag-001")
  })

  it("alerts returns rule list", async () => {
    const AlertList = Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      condition_type: Schema.String,
      threshold: Schema.Number,
      action: Schema.String,
      enabled: Schema.Boolean,
    }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/alerts", AlertList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("High cost")
    expect(result[0].enabled).toBe(true)
  })
})
