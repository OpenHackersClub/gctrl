/**
 * Worker API smoke tests — run inside Miniflare V8 isolate via
 * @cloudflare/vitest-pool-workers, testing the same runtime as production.
 */
import { SELF } from "cloudflare:test"
import { describe, it, expect } from "vitest"

describe("Worker API smoke tests", () => {
  it("GET /api/board/projects returns 200 with array", async () => {
    const res = await SELF.fetch("http://fake-host/api/board/projects")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it("GET /api/inbox/stats returns stub data", async () => {
    const res = await SELF.fetch("http://fake-host/api/inbox/stats")
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data.total).toBe(0)
    expect(data.unread).toBe(0)
    expect(data.requires_action).toBe(0)
  })

  it("GET /api/unknown returns 404", async () => {
    const res = await SELF.fetch("http://fake-host/api/unknown")
    expect(res.status).toBe(404)
  })

  it("OPTIONS /api/board/projects returns CORS headers", async () => {
    const res = await SELF.fetch("http://fake-host/api/board/projects", {
      method: "OPTIONS",
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("POST /api/board/projects creates a project", async () => {
    const res = await SELF.fetch("http://fake-host/api/board/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Smoke Test", key: "SMOKE" }),
    })
    expect(res.status).toBe(201)
    const data = (await res.json()) as Record<string, unknown>
    expect(data.name).toBe("Smoke Test")
    expect(data.key).toBe("SMOKE")
  })

  it("POST /api/board/projects rejects missing fields", async () => {
    const res = await SELF.fetch("http://fake-host/api/board/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Key" }),
    })
    expect(res.status).toBe(400)
  })
})
