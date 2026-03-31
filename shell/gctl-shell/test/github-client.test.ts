import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { GitHubClient } from "../src/services/GitHubClient.js"
import type { GhIssue, GhPR, GhRun } from "../src/services/GitHubClient.js"
import { createMockGitHubClient } from "./helpers/mock-kernel.js"

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

const MockLayer = createMockGitHubClient({
  issues: mockIssues,
  prs: mockPRs,
  runs: mockRuns,
})

describe("GitHubClient port", () => {
  it("lists issues via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listIssues("org/gctrl")
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toHaveLength(1)
    expect(result[0].number).toBe(42)
    expect(result[0].title).toBe("Implement kernel scheduler")
    expect(result[0].labels).toContain("kernel")
  })

  it("views single issue via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewIssue("org/gctrl", 42)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result.number).toBe(42)
    expect(result.author).toBe("debuggingfuture")
  })

  it("creates issue via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.createIssue("org/gctrl", {
        title: "New issue",
        body: "Description",
        labels: ["bug"],
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result.number).toBe(999)
    expect(result.title).toBe("New issue")
    expect(result.state).toBe("open")
  })

  it("lists PRs via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listPRs("org/gctrl")
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toHaveLength(1)
    expect(result[0].number).toBe(99)
    expect(result[0].branch).toBe("feat/initial-scaffold")
  })

  it("views single PR via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewPR("org/gctrl", 99)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result.number).toBe(99)
    expect(result.author).toBe("debuggingfuture")
  })

  it("lists workflow runs via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.listRuns("org/gctrl", { branch: "feat/initial-scaffold" })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result).toHaveLength(1)
    expect(result[0].conclusion).toBe("success")
  })

  it("views single run via mock", async () => {
    const program = Effect.gen(function* () {
      const gh = yield* GitHubClient
      return yield* gh.viewRun("org/gctrl", 12345)
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockLayer))
    )

    expect(result.id).toBe(12345)
    expect(result.name).toBe("CI/CD")
    expect(result.status).toBe("completed")
  })
})
