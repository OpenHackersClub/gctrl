import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"
import { buildRunEnv } from "../src/commands/opencode"

const mockOpencodeSessions = [
  {
    id: "sess-oc-001",
    agent_name: "opencode",
    status: "completed",
    started_at: "2026-04-28T09:00:00Z",
    total_cost_usd: 0,
    total_input_tokens: 1024,
    total_output_tokens: 512,
  },
]

const mockOpencodeSpans = [
  {
    span_id: "span-oc-1",
    operation_name: "chat.completion",
    span_type: "generation",
    model: "google/gemma-3-26b",
    cost_usd: 0,
    duration_ms: 432,
    status: "ok",
  },
]

const mockOpencodePrompts = {
  session_id: "sess-oc-001",
  count: 2,
  prompts: [
    {
      id: "p-1",
      session_id: "sess-oc-001",
      turn_ordinal: 0,
      role: "user",
      content: "fix the failing test",
      fingerprint: "fp-1",
      tokens: 8,
    },
    {
      id: "p-2",
      session_id: "sess-oc-001",
      turn_ordinal: 1,
      role: "assistant",
      content: "looking at the test now…",
      fingerprint: "fp-2",
      tokens: 6,
    },
  ],
}

const MockLayer = createMockKernelClient({
  "/api/sessions": mockOpencodeSessions,
  "/api/sessions/sess-oc-001/spans": mockOpencodeSpans,
  "/api/sessions/sess-oc-001/prompts": mockOpencodePrompts,
})

describe("opencode commands (via KernelClient)", () => {
  it("sessions filter routes through /api/sessions with agent_name=opencode", async () => {
    const SessionList = Schema.Array(
      Schema.Struct({ id: Schema.String, agent_name: Schema.String, total_cost_usd: Schema.Number })
    )

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/sessions?agent_name=opencode&limit=20",
        SessionList
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].agent_name).toBe("opencode")
  })

  it("last fetches prompt bodies for the session", async () => {
    const PromptList = Schema.Struct({
      session_id: Schema.String,
      count: Schema.Number,
      prompts: Schema.Array(
        Schema.Struct({ role: Schema.String, content: Schema.String, turn_ordinal: Schema.Number })
      ),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions/sess-oc-001/prompts", PromptList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.count).toBe(2)
    expect(result.prompts[0].role).toBe("user")
    expect(result.prompts[1].role).toBe("assistant")
  })

  it("last fetches the most recent opencode session and its spans", async () => {
    const SessionList = Schema.Array(Schema.Struct({ id: Schema.String, agent_name: Schema.String }))
    const SpanList = Schema.Array(
      Schema.Struct({
        span_id: Schema.String,
        operation_name: Schema.String,
        model: Schema.NullOr(Schema.String),
      })
    )

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const sessions = yield* kernel.get(
        "/api/sessions?agent_name=opencode&limit=1",
        SessionList
      )
      const spans = yield* kernel.get(
        `/api/sessions/${sessions[0].id}/spans`,
        SpanList
      )
      return { sessions, spans }
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.sessions[0].id).toBe("sess-oc-001")
    expect(result.spans[0].model).toBe("google/gemma-3-26b")
  })
})

describe("buildRunEnv", () => {
  const inputs = {
    sessionId: "11111111-2222-3333-4444-555555555555",
    kernelPort: 4318,
    relayPort: 4319,
    upstream: "http://127.0.0.1:1234/v1/chat/completions",
  }

  it("sets OTel resource attrs with session.id + service.name", () => {
    const env = buildRunEnv(inputs)
    expect(env.OTEL_SERVICE_NAME).toBe("opencode")
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("service.name=opencode")
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`session.id=${inputs.sessionId}`)
  })

  it("points OTLP traces at the kernel daemon port", () => {
    const env = buildRunEnv(inputs)
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      "http://localhost:4318/v1/traces"
    )
  })

  it("forwards relay + upstream config to the proxy via env", () => {
    const env = buildRunEnv(inputs)
    expect(env.GCTRL_RELAY_PORT).toBe("4319")
    expect(env.OPENCODE_LLM_UPSTREAM).toBe(inputs.upstream)
    expect(env.OPENCODE_SESSION_ID).toBe(inputs.sessionId)
  })

  it("preserves base env (e.g. PATH, HOME) so opencode can find its config", () => {
    const env = buildRunEnv(inputs, { PATH: "/usr/bin", HOME: "/root" })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/root")
  })

  it("overrides any conflicting keys in base env (telemetry must win)", () => {
    const env = buildRunEnv(inputs, { OTEL_SERVICE_NAME: "stale" })
    expect(env.OTEL_SERVICE_NAME).toBe("opencode")
  })
})
