/**
 * KernelClient — HTTP adapter for calling the gctrl kernel API.
 *
 * All board operations go through the Rust daemon's HTTP API on :4318.
 * This is the app boundary: Effect-TS apps talk to the kernel via HTTP only.
 *
 * Uses @effect/platform HttpClient with typed TaggedErrors and Effect.catchTags.
 */
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, HttpBody } from "@effect/platform"
import { KernelError, KernelUnavailableError } from "../services/errors.js"

export class KernelClient extends Context.Tag("KernelClient")<
  KernelClient,
  {
    readonly get: (path: string) => Effect.Effect<unknown, KernelError | KernelUnavailableError>
    readonly post: (path: string, body: unknown) => Effect.Effect<unknown, KernelError | KernelUnavailableError>
  }
>() {}

/**
 * Live adapter that calls the gctrl daemon HTTP API via @effect/platform HttpClient.
 * Maps HttpClientError tags to KernelError / KernelUnavailableError.
 */
export const KernelClientLive = (baseUrl = "http://localhost:4318") =>
  Layer.effect(
    KernelClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return {
        get: (path: string) =>
          client.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((res) => {
              if (res.status < 200 || res.status >= 300) {
                return Effect.flatMap(res.text, (text) =>
                  Effect.fail(new KernelError({ message: `${res.status}: ${text}`, statusCode: res.status }))
                )
              }
              return res.json
            }),
            Effect.scoped,
            Effect.catchTag("RequestError", () =>
              Effect.fail(
                new KernelUnavailableError({
                  message: `Cannot reach kernel at ${baseUrl}. Is 'gctrl serve' running?`,
                })
              )
            ),
            Effect.catchTag("ResponseError", (e) =>
              Effect.fail(
                new KernelError({ message: e.message, statusCode: e.response.status })
              )
            ),
          ),

        post: (path: string, body: unknown) =>
          client
            .post(`${baseUrl}${path}`, { body: HttpBody.unsafeJson(body) })
            .pipe(
              Effect.flatMap((res) => {
                if (res.status < 200 || res.status >= 300) {
                  return Effect.flatMap(res.text, (text) =>
                    Effect.fail(new KernelError({ message: `${res.status}: ${text}`, statusCode: res.status }))
                  )
                }
                if (res.status === 204) return Effect.succeed(null)
                return res.json
              }),
              Effect.scoped,
              Effect.catchTag("RequestError", () =>
                Effect.fail(
                  new KernelUnavailableError({
                    message: `Cannot reach kernel at ${baseUrl}. Is 'gctrl serve' running?`,
                  })
                )
              ),
              Effect.catchTag("ResponseError", (e) =>
                Effect.fail(
                  new KernelError({ message: e.message, statusCode: e.response.status })
                )
              ),
            ),
      }
    })
  )
