/**
 * Shared mock factory for KernelClient.
 *
 * Allows test files to declare only the mock data they need:
 *   createMockKernelClient({ "/api/sessions": [...], "/api/analytics": {...} })
 *
 * GitHub commands also route through KernelClient (via /api/github/* kernel routes),
 * so GitHub mocks are just additional route entries in the same mock.
 */
import { Effect, Layer, Schema } from "effect"
import { KernelClient } from "../../src/services/KernelClient"
import { KernelError, KernelUnavailableError } from "../../src/errors"

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
