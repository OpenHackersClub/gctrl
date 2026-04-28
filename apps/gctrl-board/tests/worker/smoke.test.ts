/**
 * Worker API smoke tests — run inside Miniflare V8 isolate via
 * @cloudflare/vitest-pool-workers, testing the same runtime as production.
 *
 * Uses @effect/platform HttpClient (wired to SELF.fetch in fixtures/http.ts)
 * so tests exercise the same Effect HTTP path as production adapters.
 */
import { HttpBody, HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { HOST, runTest } from "./fixtures/http"

describe("Worker API smoke tests", () => {
  it("GET /api/board/projects returns 200 with array", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/projects`)
        expect(res.status).toBe(200)
        const data = yield* res.json
        expect(Array.isArray(data)).toBe(true)
      }),
    ))

  it("GET /api/inbox/stats falls through to kernel facade", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/inbox/stats`)
        // Worker no longer shadows the kernel; without KERNEL_URL set in the
        // test env, an unmatched /api/* path returns 404 (vs. 502 if proxy is
        // wired but the kernel is unreachable).
        expect(res.status).toBe(404)
      }),
    ))

  it("GET /api/unknown returns 404", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/unknown`)
        expect(res.status).toBe(404)
      }),
    ))

  it("OPTIONS /api/board/projects returns CORS headers", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.execute(
          HttpClientRequest.options(`${HOST}/api/board/projects`),
        )
        expect(res.status).toBe(204)
        expect(res.headers["access-control-allow-origin"]).toBe("*")
      }),
    ))

  it("POST /api/board/projects creates a project", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/projects`, {
          body: HttpBody.unsafeJson({ name: "Smoke Test", key: "SMOKE" }),
        })
        expect(res.status).toBe(201)
        const data = (yield* res.json) as Record<string, unknown>
        expect(data.name).toBe("Smoke Test")
        expect(data.key).toBe("SMOKE")
      }),
    ))

  it("POST /api/board/projects rejects missing fields", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/projects`, {
          body: HttpBody.unsafeJson({ name: "No Key" }),
        })
        expect(res.status).toBe(400)
      }),
    ))
})
