/**
 * Shared mock factories for KernelClient and GitHubClient.
 *
 * Allows test files to declare only the mock data they need:
 *   createMockKernelClient({ "/api/sessions": [...], "/api/analytics": {...} })
 */
import { Effect, Layer, Schema } from "effect"
import { KernelClient } from "../../src/services/KernelClient.js"
import { GitHubClient } from "../../src/services/GitHubClient.js"
import type { GhIssue, GhPR, GhRun } from "../../src/services/GitHubClient.js"
import { KernelError, KernelUnavailableError } from "../../src/errors.js"
import { GitHubError } from "../../src/errors.js"

type RouteMap = Record<string, unknown>

/**
 * Create a mock KernelClient Layer that routes GET/POST/DELETE by path prefix.
 */
export const createMockKernelClient = (
  routes: RouteMap,
  postRoutes: RouteMap = {},
  textRoutes: Record<string, string> = {}
) =>
  Layer.succeed(KernelClient, {
    get: (path, schema) =>
      Effect.gen(function* () {
        const match = findRoute(routes, path)
        if (match === undefined) {
          return yield* Effect.fail(
            new KernelError({ message: `Mock: not found ${path}`, statusCode: 404 })
          )
        }
        return yield* Schema.decodeUnknown(schema)(match)
      }),

    post: (path, _body, schema) =>
      Effect.gen(function* () {
        const match = findRoute(postRoutes, path) ?? findRoute(routes, path)
        if (match === undefined) {
          return yield* Effect.fail(
            new KernelError({ message: `Mock: not found ${path}`, statusCode: 404 })
          )
        }
        return yield* Schema.decodeUnknown(schema)(match)
      }),

    delete: (path) =>
      Effect.gen(function* () {
        if (!findRoute(routes, path) && !findRoute(postRoutes, path)) {
          return yield* Effect.fail(
            new KernelError({ message: `Mock: not found ${path}`, statusCode: 404 })
          )
        }
      }),

    getText: (path) =>
      Effect.gen(function* () {
        const match = findTextRoute(textRoutes, path)
        if (match === undefined) {
          return yield* Effect.fail(
            new KernelError({ message: `Mock: not found ${path}`, statusCode: 404 })
          )
        }
        return match
      }),

    health: () => Effect.succeed(true),
  })

/**
 * Find a route by matching path prefix against the route map keys.
 * Tries exact match first, then prefix match.
 */
const findRoute = (routes: RouteMap, path: string): unknown | undefined => {
  // Strip query string for matching
  const basePath = path.split("?")[0]
  // Exact match
  if (basePath in routes) return routes[basePath]
  // Prefix match (e.g., "/api/sessions" matches "/api/sessions/sess-001")
  for (const key of Object.keys(routes)) {
    if (basePath.startsWith(key)) return routes[key]
  }
  return undefined
}

const findTextRoute = (
  routes: Record<string, string>,
  path: string
): string | undefined => {
  const basePath = path.split("?")[0]
  if (basePath in routes) return routes[basePath]
  for (const key of Object.keys(routes)) {
    if (basePath.startsWith(key)) return routes[key]
  }
  return undefined
}

/**
 * Create a mock KernelClient that reports unhealthy (health() fails with KernelUnavailableError).
 * All other methods also fail with KernelUnavailableError.
 */
export const createMockUnhealthyKernelClient = () =>
  Layer.succeed(KernelClient, {
    get: (_path, _schema) =>
      Effect.fail(new KernelUnavailableError({ message: "Kernel offline" })) as never,
    post: (_path, _body, _schema) =>
      Effect.fail(new KernelUnavailableError({ message: "Kernel offline" })) as never,
    delete: (_path) =>
      Effect.fail(new KernelUnavailableError({ message: "Kernel offline" })),
    getText: (_path) =>
      Effect.fail(new KernelUnavailableError({ message: "Kernel offline" })),
    health: () =>
      Effect.fail(new KernelUnavailableError({ message: "Kernel offline" })),
  })

/**
 * Create a mock GitHubClient Layer with canned data.
 */
export const createMockGitHubClient = (data: {
  issues?: ReadonlyArray<GhIssue>
  prs?: ReadonlyArray<GhPR>
  runs?: ReadonlyArray<GhRun>
}) =>
  Layer.succeed(GitHubClient, {
    listIssues: (_repo, _options) =>
      Effect.succeed(data.issues ?? []),
    viewIssue: (_repo, number) => {
      const issue = (data.issues ?? []).find((i) => i.number === number)
      return issue
        ? Effect.succeed(issue)
        : Effect.fail(new GitHubError({ message: `Issue #${number} not found` }))
    },
    createIssue: (_repo, input) =>
      Effect.succeed({
        number: 999,
        title: input.title,
        state: "open",
        author: "test",
        labels: input.labels ?? [],
        createdAt: "2026-03-31T00:00:00Z",
        url: "https://github.com/org/repo/issues/999",
      }),
    listPRs: (_repo, _options) =>
      Effect.succeed(data.prs ?? []),
    viewPR: (_repo, number) => {
      const pr = (data.prs ?? []).find((p) => p.number === number)
      return pr
        ? Effect.succeed(pr)
        : Effect.fail(new GitHubError({ message: `PR #${number} not found` }))
    },
    listRuns: (_repo, _options) =>
      Effect.succeed(data.runs ?? []),
    viewRun: (_repo, runId) => {
      const run = (data.runs ?? []).find((r) => r.id === runId)
      return run
        ? Effect.succeed(run)
        : Effect.fail(new GitHubError({ message: `Run #${runId} not found` }))
    },
  })
