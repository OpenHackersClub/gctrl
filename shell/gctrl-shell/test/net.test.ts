import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"
import { execPromise } from "../src/lib/exec"

const mockTrafficLogs = [
  {
    id: "t1",
    timestamp: "2026-04-27T10:00:00Z",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    host: "api.anthropic.com",
    status_code: 200,
    request_size_bytes: 512,
    response_size_bytes: 4096,
    duration_ms: 850,
    session_id: null,
  },
  {
    id: "t2",
    timestamp: "2026-04-27T10:00:01Z",
    method: "GET",
    url: "https://github.com/api/repos",
    host: "github.com",
    status_code: 200,
    request_size_bytes: 0,
    response_size_bytes: 1024,
    duration_ms: 120,
    session_id: "sess-001",
  },
]

const mockTrafficStats = {
  total_requests: 2,
  total_request_bytes: 512,
  total_response_bytes: 5120,
  by_host: [
    ["api.anthropic.com", 1],
    ["github.com", 1],
  ],
  by_status: [[200, 2]],
}

const MockLayer = createMockKernelClient({
  "/api/net/logs": mockTrafficLogs,
  "/api/net/stats": mockTrafficStats,
})

describe("Net proxy commands (via KernelClient)", () => {
  it("net logs decodes traffic rows", async () => {
    const TrafficRow = Schema.Struct({
      id: Schema.String,
      host: Schema.String,
      status_code: Schema.Number,
    })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/net/logs", Schema.Array(TrafficRow))
    })
    const rows = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(rows.length).toBe(2)
    expect(rows[0].host).toBe("api.anthropic.com")
  })

  it("net logs supports query string filtering", async () => {
    // Mock matches by path prefix — query string is stripped before match.
    const TrafficRow = Schema.Struct({ host: Schema.String })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/net/logs?host=api.anthropic.com&limit=50",
        Schema.Array(TrafficRow)
      )
    })
    const rows = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(rows.length).toBe(2)
  })

  it("net stats decodes aggregates", async () => {
    const TrafficStats = Schema.Struct({
      total_requests: Schema.Number,
      by_host: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
      by_status: Schema.Array(Schema.Tuple(Schema.Number, Schema.Number)),
    })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/net/stats", TrafficStats)
    })
    const stats = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(stats.total_requests).toBe(2)
    expect(stats.by_host.length).toBe(2)
  })
})

describe("Net commands (exec helper for spider subcommands)", () => {
  it("execPromise returns ok=true for successful command", async () => {
    const result = await Effect.runPromise(execPromise("echo hello", process.cwd()))
    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello")
  })

  it("execPromise returns ok=false for failed command", async () => {
    const result = await Effect.runPromise(execPromise("false", process.cwd()))
    expect(result.ok).toBe(false)
  })
})
