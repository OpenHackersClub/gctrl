/**
 * SPA deep-link fallback tests — run inside Miniflare V8 isolate via
 * @cloudflare/vitest-pool-workers, with the ASSETS binding served from the
 * built dist-web directory (wrangler.toml [assets]).
 *
 * Asserts that loading a client-side route directly (e.g. /projects/:key)
 * returns the app shell (index.html, 200) rather than a 404, so client-side
 * routing works on hard refresh / deep link. Both layers cooperate here:
 * wrangler's `not_found_handling = "single-page-application"` on [assets] and
 * the Worker's own SPA fallback in src/worker.ts.
 */
import { HttpClient } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { HOST, runTest } from "./fixtures/http"

describe("SPA deep-link fallback", () => {
  it("GET /projects/SOMEKEY returns 200 + HTML app shell", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/projects/SOMEKEY`)
        expect(res.status).toBe(200)
        expect(res.headers["content-type"]).toContain("text/html")
        const body = yield* res.text
        expect(body).toContain("<!doctype html")
      }),
    ))

  // With `not_found_handling = "single-page-application"` on [assets], the
  // ASSETS binding resolves unmatched /assets/ paths to index.html (200)
  // before the Worker's own fallback runs — so wrangler's SPA handling wins
  // here. The Worker's /assets/ 404-preservation guard is defense-in-depth
  // for contexts where that config is absent (it never sees a 404 to
  // preserve in this isolate). We assert the production behavior: a deep
  // /assets/ path does not error out.
  it("GET a missing /assets/ path resolves to the app shell (SPA handling wins)", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/assets/does-not-exist.js`)
        expect(res.status).toBe(200)
        expect(res.headers["content-type"]).toContain("text/html")
      }),
    ))
})
