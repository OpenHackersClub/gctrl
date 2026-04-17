/**
 * Worker test HTTP fixture — the only place `SELF.fetch` is referenced.
 *
 * Tests drive the Worker handler through `@effect/platform` `HttpClient`,
 * with `FetchHttpClient.Fetch` swapped for `SELF.fetch` so requests land
 * in-isolate (same bindings, same env). This keeps tests on the same
 * Effect HTTP path as production adapters (src/adapters/KernelClient.ts).
 */
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Effect, Layer } from "effect"
import { SELF } from "cloudflare:test"

const WorkerFetch = Layer.succeed(
  FetchHttpClient.Fetch,
  ((input, init) => SELF.fetch(input as RequestInfo, init)) as typeof fetch,
)

export const TestHttpClient = FetchHttpClient.layer.pipe(Layer.provide(WorkerFetch))

/** Run an Effect program with TestHttpClient provided. */
export const runTest = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> =>
  program.pipe(
    Effect.provide(TestHttpClient),
    Effect.scoped,
    Effect.runPromise,
  )

export const HOST = "http://fake-host"
