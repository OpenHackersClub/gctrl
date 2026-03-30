/**
 * KernelClient — HTTP adapter for calling the gctl kernel API.
 *
 * All board operations go through the Rust daemon's HTTP API on :4318.
 * This is the shell boundary: Effect-TS apps talk to the kernel via HTTP only.
 */
import { Context, Effect, Layer } from "effect"

export class KernelClient extends Context.Tag("KernelClient")<
  KernelClient,
  {
    readonly get: (path: string) => Effect.Effect<unknown, Error>
    readonly post: (path: string, body: unknown) => Effect.Effect<unknown, Error>
  }
>() {}

/**
 * Live adapter that calls the gctl daemon HTTP API.
 */
export const KernelClientLive = (baseUrl = "http://localhost:4318") =>
  Layer.succeed(KernelClient, {
    get: (path) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${baseUrl}${path}`)
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`${res.status}: ${text}`)
          }
          return res.json()
        },
        catch: (e) => new Error(String(e)),
      }),
    post: (path, body) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`${res.status}: ${text}`)
          }
          if (res.status === 204) return null
          return res.json()
        },
        catch: (e) => new Error(String(e)),
      }),
  })
