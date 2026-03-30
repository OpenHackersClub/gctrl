import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { GitHubClient } from "../src/services/GitHubClient.js"
import type { GhIssue, GhPR, GhRun } from "../src/services/GitHubClient.js"

const mockIssues: ReadonlyArray<GhIssue> = [
  {
    number: 42,
    title: "Implement kernel scheduler",
    state: "open",
    author: "debuggingfuture",
    labels: ["enhancement", "kernel"],
    createdAt: "2026-03-28T10:00:00Z",
    url: "https://github.com/org/gctrl/issues/42",
  },
]

const mockPRs: ReadonlyArray<GhPR> = [
  {
    number: 99,
    title: "feat: add Effect-TS shell CLI",
    state: "open",
    author: "debuggingfuture",
    branch: "feat/initial-scaffold",
    url: "https://github.com/org/gctrl/pull/99",
  },
]

const mockRuns: ReadonlyArray<GhRun> = [
  {
    id: 12345,
    name: "CI/CD",
    status: "completed",
    conclusion: "success",
    branch: "feat/initial-scaffold",
    url: "https://github.com/org/gctrl/actions/runs/12345",
  },
]

const MockGitHubClientLive = Layer.succeed(GitHubClient, {
  listIssues: (_repo, _options) => Effect.succeed(mockIssues),
  listPRs: (_repo, _options) => Effect.succeed(mockPRs),
  listRuns: (_repo, _options) => Effect.succeed(mockRuns),
})

describe("GitHubClient port", () => {
  it("lists issues via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listIssues("org/gctrl")
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockGitHubClientLive))
    )

    expect(result).toHaveLength(1)
    expect(result[0].number).toBe(42)
    expect(result[0].title).toBe("Implement kernel scheduler")
    expect(result[0].labels).toContain("kernel")
  })

  it("lists PRs via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listPRs("org/gctrl")
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockGitHubClientLive))
    )

    expect(result).toHaveLength(1)
    expect(result[0].number).toBe(99)
    expect(result[0].branch).toBe("feat/initial-scaffold")
  })

  it("lists workflow runs via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listRuns("org/gctrl", { branch: "feat/initial-scaffold" })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockGitHubClientLive))
    )

    expect(result).toHaveLength(1)
    expect(result[0].conclusion).toBe("success")
  })
})
