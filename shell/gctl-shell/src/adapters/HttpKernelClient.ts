/**
 * HttpKernelClient — concrete adapter that calls the gctl kernel HTTP API.
 *
 * Uses fetch to communicate with the Rust daemon on :4318.
 */
import { Effect, Layer, Schema } from "effect"
import { KernelClient } from "../services/KernelClient.js"
import { KernelError, KernelUnavailableError } from "../errors.js"

export const HttpKernelClientLive = (baseUrl = "http://localhost:4318") =>
  Layer.succeed(KernelClient, {
    get: (path, schema) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${baseUrl}${path}`),
          catch: () =>
            new KernelUnavailableError({
              message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
            }),
        })
        if (!res.ok) {
          const text = yield* Effect.promise(() => res.text())
          return yield* Effect.fail(
            new KernelError({ message: text, statusCode: res.status })
          )
        }
        const json = yield* Effect.promise(() => res.json())
        return yield* Schema.decodeUnknown(schema)(json).pipe(
          Effect.catchAll((e) =>
            Effect.fail(new KernelError({ message: `Schema decode: ${e}` }))
          )
        )
      }),

    post: (path, body, schema) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${baseUrl}${path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          catch: () =>
            new KernelUnavailableError({
              message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
            }),
        })
        if (!res.ok) {
          const text = yield* Effect.promise(() => res.text())
          return yield* Effect.fail(
            new KernelError({ message: text, statusCode: res.status })
          )
        }
        if (res.status === 204) {
          return yield* Schema.decodeUnknown(schema)(null).pipe(
            Effect.catchAll((e) =>
              Effect.fail(new KernelError({ message: `Schema decode: ${e}` }))
            )
          )
        }
        const json = yield* Effect.promise(() => res.json())
        return yield* Schema.decodeUnknown(schema)(json).pipe(
          Effect.catchAll((e) =>
            Effect.fail(new KernelError({ message: `Schema decode: ${e}` }))
          )
        )
      }),

    delete: (path) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${baseUrl}${path}`, { method: "DELETE" }),
          catch: () =>
            new KernelUnavailableError({
              message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
            }),
        })
        if (!res.ok) {
          const text = yield* Effect.promise(() => res.text())
          return yield* Effect.fail(
            new KernelError({ message: text, statusCode: res.status })
          )
        }
      }),

    health: () =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${baseUrl}/health`)
          return res.ok
        },
        catch: () =>
          new KernelUnavailableError({
            message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
          }),
      }),
  })
