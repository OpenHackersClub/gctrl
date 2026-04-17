/**
 * Effect-based seed helpers for Worker runtime tests.
 * Uses @effect/platform HttpClient (provided by fixtures/http.ts).
 */
import { HttpBody, HttpClient } from "@effect/platform"
import { Effect } from "effect"
import { HOST } from "./http"

export type SeededProject = { id: string; key: string; counter: number }

export const seedProject = (name: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const res = yield* client.post(`${HOST}/api/board/projects`, {
      body: HttpBody.unsafeJson({ name, key }),
    })
    if (res.status !== 201) {
      const body = yield* res.text
      return yield* Effect.die(`seedProject failed: ${res.status} ${body}`)
    }
    return (yield* res.json) as SeededProject
  })

export const seedIssue = (
  projectId: string,
  title: string,
  extra?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const res = yield* client.post(`${HOST}/api/board/issues`, {
      body: HttpBody.unsafeJson({
        project_id: projectId,
        title,
        created_by_id: "user-1",
        created_by_name: "Alice",
        created_by_type: "human",
        ...extra,
      }),
    })
    if (res.status !== 201) {
      const body = yield* res.text
      return yield* Effect.die(`seedIssue failed: ${res.status} ${body}`)
    }
    return (yield* res.json) as Record<string, unknown>
  })
