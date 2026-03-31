import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { GitHubClient } from "../src/services/GitHubClient.js"
import { createMockKernelClient, createMockGitHubClient } from "./helpers/mock-kernel.js"

/**
 * Tests that all list/collection endpoints handle empty arrays correctly.
 * These mirror the "No X found." branches in the command handlers.
 */

const EmptyKernelLayer = createMockKernelClient(
  {
    "/api/sessions": [],
    "/api/board/projects": [],
    "/api/board/issues": [],
    "/api/board/issues/iss-1/comments": [],
    "/api/board/issues/iss-1/events": [],
    "/api/context": [],
    "/api/analytics/alerts": [],
    "/api/analytics/daily": [],
    "/api/analytics/cost": { by_model: [], by_agent: [] },
    "/api/analytics/latency": { by_model: [] },
    "/api/analytics/spans": { distribution: [] },
  },
  {},
  { "/api/context/compact": "" }
)

const EmptyGitHubLayer = createMockGitHubClient({})

describe("Empty result handling — KernelClient paths", () => {
  it("sessions list returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/sessions?limit=20",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("board projects list returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/board/projects",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("board issues list returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/board/issues?limit=50",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("board comments returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/board/issues/iss-1/comments",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("board events returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/board/issues/iss-1/events",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("context list returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/context?limit=100",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("analytics alerts returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/analytics/alerts",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("analytics daily returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/analytics/daily?days=7",
        Schema.Array(Schema.Struct({ date: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toHaveLength(0)
  })

  it("analytics cost returns empty by_model and by_agent", async () => {
    const CostAnalytics = Schema.Struct({
      by_model: Schema.Array(Schema.Struct({ model: Schema.String })),
      by_agent: Schema.Array(Schema.Struct({ agent: Schema.String })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/cost", CostAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result.by_model).toHaveLength(0)
    expect(result.by_agent).toHaveLength(0)
  })

  it("analytics latency returns empty by_model", async () => {
    const LatencyAnalytics = Schema.Struct({
      by_model: Schema.Array(Schema.Struct({ model: Schema.String })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/latency", LatencyAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result.by_model).toHaveLength(0)
  })

  it("analytics spans returns empty distribution", async () => {
    const SpanAnalytics = Schema.Struct({
      distribution: Schema.Array(Schema.Struct({ count: Schema.Number })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/analytics/spans", SpanAnalytics)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result.distribution).toHaveLength(0)
  })

  it("context compact returns empty string", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/compact")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyKernelLayer)))
    expect(result).toBe("")
  })
})

describe("Empty result handling — GitHubClient paths", () => {
  it("listIssues returns empty array", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listIssues("org/repo")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyGitHubLayer)))
    expect(result).toHaveLength(0)
  })

  it("listPRs returns empty array", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listPRs("org/repo")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyGitHubLayer)))
    expect(result).toHaveLength(0)
  })

  it("listRuns returns empty array", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listRuns("org/repo")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyGitHubLayer)))
    expect(result).toHaveLength(0)
  })
})
