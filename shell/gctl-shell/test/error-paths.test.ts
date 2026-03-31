import { describe, it, expect } from "vitest"
import { Effect, Either, Schema, Layer } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { GitHubClient } from "../src/services/GitHubClient.js"
import { KernelError, KernelUnavailableError, GitHubError, GitHubAuthError } from "../src/errors.js"
import { createMockKernelClient, createMockGitHubClient } from "./helpers/mock-kernel.js"

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

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const err = result.left
      expect(err._tag).toBe("KernelError")
      expect((err as KernelError).statusCode).toBe(404)
      expect((err as KernelError).message).toContain("not found")
    }
  })

  it("POST unknown path yields KernelError with 404", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/nonexistent", { data: 1 }, Schema.String)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("KernelError")
    }
  })

  it("DELETE unknown path yields KernelError with 404", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/nonexistent")
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("KernelError")
    }
  })

  it("getText unknown path yields KernelError", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/nonexistent")
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("KernelError")
    }
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
    expect(err._tag).toBe("KernelError")
    expect(err.message).toBe("test error")
    expect(err.statusCode).toBe(500)
  })

  it("KernelUnavailableError is tagged correctly", () => {
    const err = new KernelUnavailableError({ message: "offline" })
    expect(err._tag).toBe("KernelUnavailableError")
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

// ---------- GitHubClient error paths ----------

describe("GitHubClient error paths", () => {
  const MockLayer = createMockGitHubClient({
    issues: [
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
    prs: [
      {
        number: 10,
        title: "PR",
        state: "open",
        author: "user",
        branch: "feat/x",
        url: "https://github.com/org/repo/pull/10",
      },
    ],
    runs: [
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

  it("viewIssue with nonexistent number yields GitHubError", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewIssue("org/repo", 999)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("GitHubError")
      expect((result.left as GitHubError).message).toContain("999")
    }
  })

  it("viewPR with nonexistent number yields GitHubError", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewPR("org/repo", 999)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("GitHubError")
      expect((result.left as GitHubError).message).toContain("999")
    }
  })

  it("viewRun with nonexistent ID yields GitHubError", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewRun("org/repo", 99999)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(MockLayer)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("GitHubError")
      expect((result.left as GitHubError).message).toContain("99999")
    }
  })

  it("GitHubError is tagged correctly", () => {
    const err = new GitHubError({ message: "API failure" })
    expect(err._tag).toBe("GitHubError")
    expect(err.message).toBe("API failure")
  })

  it("GitHubAuthError is tagged correctly", () => {
    const err = new GitHubAuthError({ message: "no token" })
    expect(err._tag).toBe("GitHubAuthError")
    expect(err.message).toBe("no token")
  })

  it("catchTag GitHubError works in Effect pipeline", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewIssue("org/repo", 404)
    }).pipe(
      Effect.catchTag("GitHubError", (e) =>
        Effect.succeed(`caught: ${e.message}`)
      )
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toContain("caught:")
  })

  it("empty mock returns empty arrays", async () => {
    const EmptyLayer = createMockGitHubClient({})

    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      const issues = yield* gh.listIssues("org/repo")
      const prs = yield* gh.listPRs("org/repo")
      const runs = yield* gh.listRuns("org/repo")
      return { issues, prs, runs }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(EmptyLayer))
    )

    expect(result.issues).toHaveLength(0)
    expect(result.prs).toHaveLength(0)
    expect(result.runs).toHaveLength(0)
  })
})
