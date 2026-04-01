import { describe, it, expect } from "vitest"
import { Effect, Either, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelError, KernelUnavailableError } from "../src/errors"
import { createMockKernelClient } from "./helpers/mock-kernel"

/** Type-safe error assertion: checks Either is Left and error matches expected class */
const expectLeftWith = <E>(result: Either.Either<unknown, E>, ErrorClass: new (...args: any[]) => E) => {
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(ErrorClass)
    return result.left
  }
  throw new Error("Expected Left")
}

// ---------- KernelClient error paths ----------

describe("KernelClient error paths", () => {
  const MockLayer = createMockKernelClient(
    { "/api/sessions": [{ id: "sess-001" }] },
    {},
    {}
  )

  it("GET unknown path yields KernelError with 404", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/nonexistent", Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    const err = expectLeftWith(result, KernelError)
    expect((err as KernelError).statusCode).toBe(404)
    expect((err as KernelError).message).toContain("not found")
  })

  it("POST unknown path yields KernelError with 404", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/nonexistent", { data: 1 }, Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expectLeftWith(result, KernelError)
  })

  it("DELETE unknown path yields KernelError with 404", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/nonexistent")
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expectLeftWith(result, KernelError)
  })

  it("getText unknown path yields KernelError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/nonexistent")
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expectLeftWith(result, KernelError)
  })

  it("schema mismatch yields a decode error (wrong type)", async () => {
    // Route returns an array, but we decode as a struct
    const WrongSchema = Schema.Struct({ name: Schema.String })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/sessions", WrongSchema)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    // Schema.decodeUnknown will fail because an array cannot decode as Struct
    expect(Either.isLeft(result)).toBe(true)
  })

  it("KernelError is tagged correctly", () => {
    const err = new KernelError({ message: "test error", statusCode: 500 })
    expect(err).toBeInstanceOf(KernelError)
    expect(err.message).toBe("test error")
    expect(err.statusCode).toBe(500)
  })

  it("KernelUnavailableError is tagged correctly", () => {
    const err = new KernelUnavailableError({ message: "offline" })
    expect(err).toBeInstanceOf(KernelUnavailableError)
    expect(err.message).toBe("offline")
  })

  it("catchTag KernelError works in Effect pipeline", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/nonexistent", Schema.String)
    }).pipe(
      Effect.catchTag("KernelError", (e) =>
        Effect.succeed(`caught: ${e.statusCode}`)
      )
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toBe("caught: 404")
  })
})

// ---------- GitHub error paths (via KernelClient /api/github/*) ----------

describe("GitHub error paths (via kernel driver)", () => {
  const MockLayer = createMockKernelClient({
    "/api/github/issues": [
      {
        number: 1,
        title: "Test",
        state: "open",
        author: "user",
        labels: [],
        createdAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/org/repo/issues/1",
      },
    ],
    "/api/github/prs": [
      {
        number: 10,
        title: "PR",
        state: "open",
        author: "user",
        branch: "feat/x",
        url: "https://github.com/org/repo/pull/10",
      },
    ],
    "/api/github/runs": [
      {
        id: 100,
        name: "CI",
        status: "completed",
        conclusion: "success",
        branch: "main",
        url: "https://github.com/org/repo/actions/runs/100",
      },
    ],
  })

  it("GET /api/github/issues returns issues via kernel", async () => {
    const GhIssueList = Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.String,
        state: Schema.String,
        author: Schema.String,
        labels: Schema.Array(Schema.String),
        createdAt: Schema.String,
        url: Schema.String,
      })
    )

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/github/issues?repo=org/repo", GhIssueList)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toHaveLength(1)
    expect(result[0].number).toBe(1)
  })

  it("GET unknown github path yields KernelError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/github/nonexistent", Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expectLeftWith(result, KernelError)
  })

  it("catchTag KernelError works for GitHub paths", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/github/nonexistent", Schema.String)
    }).pipe(
      Effect.catchTag("KernelError", (e) =>
        Effect.succeed(`caught: ${e.statusCode}`)
      )
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toBe("caught: 404")
  })
})
