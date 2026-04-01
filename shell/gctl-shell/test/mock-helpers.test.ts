import { describe, it, expect } from "vitest"
import { Effect, Either, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelUnavailableError } from "../src/errors"
import {
  createMockKernelClient,
  createMockUnhealthyKernelClient,
} from "./helpers/mock-kernel"

/**
 * Tests for the mock helper factories themselves — ensuring the routing,
 * fallback, and edge-case behavior is correct so other tests can rely on them.
 */

describe("createMockKernelClient routing", () => {
  const MockLayer = createMockKernelClient(
    {
      "/api/sessions": [{ id: "s1" }],
      "/api/sessions/s1": { id: "s1", name: "detail" },
    },
    {
      "/api/sessions/s1/end": { ok: true },
    },
    {
      "/api/context/c1/content": "Hello text content",
    }
  )

  it("exact match on GET route", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions", Schema.Array(Schema.Struct({ id: Schema.String })))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("s1")
  })

  it("prefix match: first matching prefix wins (insertion order)", async () => {
    // "/api/sessions/s1/extra" will prefix-match "/api/sessions" first (it was inserted first)
    // This documents the mock helper's behavior: exact match first, then first prefix in key order
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/sessions/s1/extra",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    // Matches "/api/sessions" (the first prefix match), not "/api/sessions/s1"
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("s1")
  })

  it("exact match takes priority over prefix match", async () => {
    // "/api/sessions/s1" is an exact match and should return the detail object
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/sessions/s1",
        Schema.Struct({ id: Schema.String, name: Schema.String })
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("s1")
    expect(result.name).toBe("detail")
  })

  it("query string is stripped for route matching", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/sessions?limit=20&agent=Claude",
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
  })

  it("POST uses postRoutes first, then falls back to routes", async () => {
    // POST to /api/sessions/s1/end should use postRoutes
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/sessions/s1/end",
        { status: "completed" },
        Schema.Struct({ ok: Schema.Boolean })
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.ok).toBe(true)
  })

  it("POST falls back to GET routes when postRoutes has no match", async () => {
    // POST to /api/sessions (not in postRoutes) should fall back to routes
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/sessions",
        { data: "test" },
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
  })

  it("getText returns from textRoutes", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/c1/content")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toBe("Hello text content")
  })

  it("getText with query string strips it for matching", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/c1/content?format=md")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toBe("Hello text content")
  })

  it("delete succeeds on existing route", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/sessions/s1")
    })

    // Should not throw
    await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
  })

  it("delete fails on unknown route", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/unknown")
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
  })

  it("health always returns true", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.health()
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toBe(true)
  })
})

describe("createMockUnhealthyKernelClient", () => {
  const UnhealthyLayer = createMockUnhealthyKernelClient()

  it("health fails with KernelUnavailableError", async () => {
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

  it("get fails with KernelUnavailableError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/anything", Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(UnhealthyLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelUnavailableError)
    }
  })

  it("post fails with KernelUnavailableError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/anything", {}, Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(UnhealthyLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelUnavailableError)
    }
  })
})

describe("GitHub routes via KernelClient mock", () => {
  const MockLayer = createMockKernelClient(
    {
      "/api/github/issues": [
        { number: 1, title: "Open", state: "open", author: "user", labels: ["bug"], createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/org/repo/issues/1" },
        { number: 2, title: "Closed", state: "closed", author: "user", labels: [], createdAt: "2026-01-02T00:00:00Z", url: "https://github.com/org/repo/issues/2" },
      ],
      "/api/github/runs": [
        { id: 1, name: "CI", status: "completed", conclusion: "success", branch: "main", url: "https://github.com/org/repo/actions/runs/1" },
      ],
    },
    {
      "/api/github/issues": { number: 999, title: "Created", state: "open", author: "test", labels: [], createdAt: "2026-03-31T00:00:00Z", url: "https://github.com/org/repo/issues/999" },
    }
  )

  it("GET /api/github/issues returns all mock data", async () => {
    const GhIssueList = Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/github/issues?repo=org/repo", GhIssueList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
  })

  it("POST /api/github/issues returns created issue", async () => {
    const GhIssue = Schema.Struct({ number: Schema.Number, title: Schema.String, state: Schema.String })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/github/issues?repo=org/repo", { title: "New" }, GhIssue)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.number).toBe(999)
    expect(result.title).toBe("Created")
  })

  it("GET /api/github/runs returns mock runs", async () => {
    const GhRunList = Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }))

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/github/runs?repo=org/repo", GhRunList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("CI")
  })
})
