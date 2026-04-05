/**
 * HttpKernelClient — concrete adapter that calls the gctl kernel HTTP API.
 *
 * Uses @effect/platform HttpClient to communicate with the Rust daemon on :4318.
 */
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpBody } from "@effect/platform"
import { KernelClient } from "../services/KernelClient"
import { KernelError, KernelUnavailableError } from "../errors"

export const HttpKernelClientLive = (baseUrl = "http://localhost:4318") =>
  Layer.effect(
    KernelClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return {
        get: (path, schema) =>
          client.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((res) => {
              if (res.status < 200 || res.status >= 300) {
                return Effect.flatMap(res.text, (text) =>
                  Effect.fail(
                    new KernelError({ message: text, statusCode: res.status })
                  )
                )
              }
              return HttpClientResponse.schemaBodyJson(schema)(res).pipe(
                Effect.catchTag("ParseError", (e) =>
                  Effect.fail(new KernelError({ message: `Schema decode: ${e}` }))
                )
              )
            }),
            Effect.scoped,
            Effect.catchTag("RequestError", () =>
              Effect.fail(
                new KernelUnavailableError({
                  message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                })
              )
            ),
            Effect.catchTag("ResponseError", (e) =>
              Effect.fail(
                new KernelError({ message: e.message, statusCode: e.response.status })
              )
            ),
          ),

        post: (path, body, schema) =>
          client
            .post(`${baseUrl}${path}`, { body: HttpBody.unsafeJson(body) })
            .pipe(
              Effect.flatMap((res) => {
                if (res.status < 200 || res.status >= 300) {
                  return Effect.flatMap(res.text, (text) =>
                    Effect.fail(
                      new KernelError({ message: text, statusCode: res.status })
                    )
                  )
                }
                if (res.status === 204) {
                  return Schema.decodeUnknown(schema)(null).pipe(
                    Effect.catchAll((e) =>
                      Effect.fail(
                        new KernelError({ message: `Schema decode: ${e}` })
                      )
                    )
                  )
                }
                return HttpClientResponse.schemaBodyJson(schema)(res).pipe(
                  Effect.catchTag("ParseError", (e) =>
                    Effect.fail(
                      new KernelError({ message: `Schema decode: ${e}` })
                    )
                  )
                )
              }),
              Effect.scoped,
              Effect.catchTag("RequestError", () =>
                Effect.fail(
                  new KernelUnavailableError({
                    message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                  })
                )
              ),
              Effect.catchTag("ResponseError", (e) =>
                Effect.fail(
                  new KernelError({ message: e.message, statusCode: e.response.status })
                )
              ),
            ),

        delete: (path) =>
          client.del(`${baseUrl}${path}`).pipe(
            Effect.flatMap((res) => {
              if (res.status < 200 || res.status >= 300) {
                return Effect.flatMap(res.text, (text) =>
                  Effect.fail(
                    new KernelError({ message: text, statusCode: res.status })
                  )
                )
              }
              return Effect.void
            }),
            Effect.scoped,
            Effect.catchTag("RequestError", () =>
              Effect.fail(
                new KernelUnavailableError({
                  message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                })
              )
            ),
            Effect.catchTag("ResponseError", (e) =>
              Effect.fail(
                new KernelError({ message: e.message, statusCode: e.response.status })
              )
            ),
          ),

        getText: (path) =>
          client.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((res) => {
              if (res.status < 200 || res.status >= 300) {
                return Effect.flatMap(res.text, (text) =>
                  Effect.fail(
                    new KernelError({ message: text, statusCode: res.status })
                  )
                )
              }
              return res.text
            }),
            Effect.scoped,
            Effect.catchTag("RequestError", () =>
              Effect.fail(
                new KernelUnavailableError({
                  message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                })
              )
            ),
            Effect.catchTag("ResponseError", (e) =>
              Effect.fail(
                new KernelError({ message: e.message, statusCode: e.response.status })
              )
            ),
          ),

        health: () =>
          client.get(`${baseUrl}/health`).pipe(
            Effect.map((res) => res.status >= 200 && res.status < 300),
            Effect.scoped,
            Effect.catchTags({
              RequestError: () =>
                Effect.fail(
                  new KernelUnavailableError({
                    message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                  })
                ),
              ResponseError: () =>
                Effect.fail(
                  new KernelUnavailableError({
                    message: `Cannot reach kernel at ${baseUrl}. Is 'gctl serve' running?`,
                  })
                ),
            }),
          ),
      }
    })
  )
