import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { createMockKernelClient } from "./helpers/mock-kernel.js"

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
]

const mockSessionDetail = {
  id: "sess-001",
  agent_name: "Claude Code",
  status: "active",
  started_at: "2026-03-30T10:00:00Z",
  ended_at: null,
  total_cost_usd: 0.0512,
  total_input_tokens: 15000,
  total_output_tokens: 3000,
}

const mockSpans = [
  {
    span_id: "span-1",
    trace_id: "trace-1",
    parent_span_id: null,
    session_id: "sess-001",
    agent_name: "Claude Code",
    operation_name: "chat",
    span_type: "llm",
    model: "claude-opus-4",
    input_tokens: 5000,
    output_tokens: 1000,
    cost_usd: 0.03,
    status: "ok",
    started_at: "2026-03-30T10:00:01Z",
    duration_ms: 2500,
  },
]

const mockTree = {
  session_id: "sess-001",
  span_count: 3,
  spans: [
    { span_id: "span-1", operation_name: "chat", span_type: "llm", status: "ok", duration_ms: 2500, cost_usd: 0.03 },
    { span_id: "span-2", operation_name: "read_file", span_type: "tool", status: "ok", duration_ms: 50, cost_usd: 0 },
  ],
}

const mockLoops = { session_id: "sess-001", count: 0 }

const mockCostBreakdown = {
  session_id: "sess-001",
  breakdown: [
    { model: "claude-opus-4", cost_usd: 0.0512, input_tokens: 15000, output_tokens: 3000, span_count: 5 },
  ],
}

const MockLayer = createMockKernelClient(
  {
    "/api/sessions": mockSessions,
    "/api/sessions/sess-001": mockSessionDetail,
    "/api/sessions/sess-001/spans": mockSpans,
    "/api/sessions/sess-001/tree": mockTree,
    "/api/sessions/sess-001/loops": mockLoops,
    "/api/sessions/sess-001/cost-breakdown": mockCostBreakdown,
  },
  {
    "/api/sessions/sess-001/end": { session_id: "sess-001", status: "completed", loops_detected: 0 },
    "/api/sessions/sess-001/auto-score": [
      { id: "sc-1", name: "completeness", value: 0.85, source: "auto" },
    ],
  }
)

describe("Sessions commands (via KernelClient)", () => {
  it("list returns sessions", async () => {
    const SessionList = Schema.Array(Schema.Struct({
      id: Schema.String,
      agent_name: Schema.String,
      status: Schema.String,
      total_cost_usd: Schema.Number,
    }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions?limit=20", SessionList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].agent_name).toBe("Claude Code")
  })

  it("show returns session detail", async () => {
    const SessionDetail = Schema.Struct({
      id: Schema.String,
      agent_name: Schema.String,
      status: Schema.String,
      ended_at: Schema.NullOr(Schema.String),
      total_cost_usd: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-001", SessionDetail)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("sess-001")
    expect(result.ended_at).toBeNull()
  })

  it("spans returns span list", async () => {
    const SpanList = Schema.Array(Schema.Struct({
      span_id: Schema.String,
      operation_name: Schema.String,
      span_type: Schema.String,
      model: Schema.NullOr(Schema.String),
      cost_usd: Schema.Number,
    }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-001/spans", SpanList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].operation_name).toBe("chat")
    expect(result[0].model).toBe("claude-opus-4")
  })

  it("tree returns trace tree", async () => {
    const TraceTree = Schema.Struct({
      session_id: Schema.String,
      span_count: Schema.Number,
      spans: Schema.Array(Schema.Struct({
        span_id: Schema.String,
        operation_name: Schema.String,
        span_type: Schema.String,
      })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-001/tree", TraceTree)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.span_count).toBe(3)
    expect(result.spans).toHaveLength(2)
  })

  it("end session returns result", async () => {
    const EndResult = Schema.Struct({
      session_id: Schema.String,
      status: Schema.String,
      loops_detected: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/sessions/sess-001/end", { status: "completed" }, EndResult)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.status).toBe("completed")
    expect(result.loops_detected).toBe(0)
  })

  it("auto-score returns scores", async () => {
    const ScoreList = Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      value: Schema.Number,
      source: Schema.String,
    }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/sessions/sess-001/auto-score", {}, ScoreList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("completeness")
    expect(result[0].value).toBeCloseTo(0.85)
  })

  it("loops returns detection results", async () => {
    const LoopInfo = Schema.Struct({
      session_id: Schema.String,
      count: Schema.Number,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-001/loops", LoopInfo)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.count).toBe(0)
  })

  it("cost-breakdown returns per-model data", async () => {
    const CostBreakdown = Schema.Struct({
      session_id: Schema.String,
      breakdown: Schema.Array(Schema.Struct({
        model: Schema.String,
        cost_usd: Schema.Number,
        input_tokens: Schema.Number,
        output_tokens: Schema.Number,
        span_count: Schema.Number,
      })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-001/cost-breakdown", CostBreakdown)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.breakdown).toHaveLength(1)
    expect(result.breakdown[0].model).toBe("claude-opus-4")
    expect(result.breakdown[0].span_count).toBe(5)
  })
})
