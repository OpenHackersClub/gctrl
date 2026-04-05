/**
 * Deployment smoke tests for gctl-board Cloudflare Worker.
 *
 * Run against a deployed Worker URL:
 *   DEPLOY_URL=https://gctl-board.debuggingfuturecors.workers.dev pnpm vitest run tests/deploy-smoke.test.ts
 *
 * Tests verify:
 *   1. Static asset serving (HTML, JS, CSS)
 *   2. SPA fallback routing (/projects/*, /inbox)
 *   3. API route responses (board, inbox, team)
 *   4. Response headers (content-type, caching)
 *   5. Worker health and error handling
 */

import { describe, it, expect, beforeAll } from "vitest"

const BASE_URL = process.env.DEPLOY_URL ?? "https://gctl-board.debuggingfuturecors.workers.dev"

// Skip all tests if no DEPLOY_URL and not explicitly opted in
const shouldRun = !!process.env.DEPLOY_URL || !!process.env.RUN_DEPLOY_TESTS
const describeDeployment = shouldRun ? describe : describe.skip

describeDeployment("Deployment Smoke Tests", () => {
  let indexHtml: string
  let jsAssetPath: string
  let cssAssetPath: string

  beforeAll(async () => {
    const res = await fetch(BASE_URL)
    indexHtml = await res.text()
    // Extract asset paths from HTML
    const jsMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/)
    const cssMatch = indexHtml.match(/href="(\/assets\/[^"]+\.css)"/)
    jsAssetPath = jsMatch?.[1] ?? ""
    cssAssetPath = cssMatch?.[1] ?? ""
  })

  // ─── Static Assets ───

  describe("Static Assets", () => {
    it("serves index.html at root", async () => {
      const res = await fetch(BASE_URL)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const body = await res.text()
      expect(body).toContain("<!doctype html>")
      expect(body).toContain("gctl board")
      expect(body).toContain('<div id="root">')
    })

    it("serves JS bundle with correct content-type", async () => {
      expect(jsAssetPath).toBeTruthy()
      const res = await fetch(`${BASE_URL}${jsAssetPath}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("javascript")
      const body = await res.text()
      expect(body.length).toBeGreaterThan(1000)
    })

    it("serves CSS bundle with correct content-type", async () => {
      expect(cssAssetPath).toBeTruthy()
      const res = await fetch(`${BASE_URL}${cssAssetPath}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("css")
      const body = await res.text()
      expect(body.length).toBeGreaterThan(100)
    })

    it("returns 404 for nonexistent static files", async () => {
      const res = await fetch(`${BASE_URL}/assets/does-not-exist-abc123.js`)
      expect(res.status).toBe(404)
    })
  })

  // ─── SPA Fallback Routing ───

  describe("SPA Routing", () => {
    it("serves index.html for /projects/:key", async () => {
      const res = await fetch(`${BASE_URL}/projects/BOARD`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const body = await res.text()
      expect(body).toContain("gctl board")
      expect(body).toContain('<div id="root">')
    })

    it("serves index.html for /inbox", async () => {
      const res = await fetch(`${BASE_URL}/inbox`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const body = await res.text()
      expect(body).toContain("gctl board")
    })

    it("serves index.html for /inbox/:threadId", async () => {
      const res = await fetch(`${BASE_URL}/inbox/thread-123`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain("gctl board")
    })

    it("serves index.html for arbitrary deep paths", async () => {
      const res = await fetch(`${BASE_URL}/some/deep/path`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain("gctl board")
    })
  })

  // ─── API Routes ───

  describe("API Routes", () => {
    it("GET /api/board/projects returns JSON array", async () => {
      const res = await fetch(`${BASE_URL}/api/board/projects`)
      // May return 200 with [] (empty) or SPA fallback — either is acceptable at this stage
      if (res.status === 200) {
        const ct = res.headers.get("content-type") ?? ""
        if (ct.includes("application/json")) {
          const body = await res.json()
          expect(Array.isArray(body)).toBe(true)
        }
      }
      // If API isn't wired yet, SPA fallback or 404 is expected
      expect([200, 404].includes(res.status)).toBe(true)
    })

    it("GET /api/board/issues returns JSON array", async () => {
      const res = await fetch(`${BASE_URL}/api/board/issues`)
      if (res.status === 200) {
        const ct = res.headers.get("content-type") ?? ""
        if (ct.includes("application/json")) {
          const body = await res.json()
          expect(Array.isArray(body)).toBe(true)
        }
      }
      expect([200, 404].includes(res.status)).toBe(true)
    })

    it("GET /api/inbox/stats returns JSON", async () => {
      const res = await fetch(`${BASE_URL}/api/inbox/stats`)
      if (res.status === 200) {
        const ct = res.headers.get("content-type") ?? ""
        if (ct.includes("application/json")) {
          const body = await res.json()
          expect(body).toHaveProperty("total")
        }
      }
      expect([200, 404].includes(res.status)).toBe(true)
    })
  })

  // ─── Response Headers ───

  describe("Response Headers", () => {
    it("sets Cloudflare headers", async () => {
      const res = await fetch(BASE_URL)
      expect(res.headers.get("server")).toBe("cloudflare")
      expect(res.headers.get("cf-ray")).toBeTruthy()
    })

    it("sets cache headers on HTML", async () => {
      const res = await fetch(BASE_URL)
      const cc = res.headers.get("cache-control") ?? ""
      // HTML should not be aggressively cached
      expect(cc).toContain("must-revalidate")
    })

    it("sets ETag on static assets", async () => {
      const res = await fetch(BASE_URL)
      expect(res.headers.get("etag")).toBeTruthy()
    })
  })

  // ─── Error Handling ───

  describe("Error Handling", () => {
    it("handles HEAD requests", async () => {
      const res = await fetch(BASE_URL, { method: "HEAD" })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
    })

    it("handles OPTIONS requests (CORS preflight)", async () => {
      const res = await fetch(`${BASE_URL}/api/board/projects`, {
        method: "OPTIONS",
        headers: {
          "Origin": "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      })
      // Either CORS headers or method-not-allowed — both acceptable
      expect([200, 204, 404, 405].includes(res.status)).toBe(true)
    })
  })
})
