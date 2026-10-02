import { afterEach, describe, expect, it, vi } from "vitest"
import { acquireKernelSession, releaseKernelSession } from "../tests/acceptance/fixtures/kernel-browser"

const identity = {
  id: "identity", createdAt: "2026-10-02T00:00:00Z", expiresAt: "2026-10-02T00:10:00Z",
  browserVersion: "Chromium/test", browserContextId: "context", status: "active",
  recording: { network: true, console: true, performance: true, screenshots: false, full: false, maxBytes: 1000 },
  cdpEndpoint: "ws://kernel/api/browser/sessions/identity/cdp?token=t", token: "t",
}
afterEach(() => vi.unstubAllGlobals())
describe("kernel browser acceptance identity", () => {
  it("preserves the real context identity and releases that session", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(identity, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    expect(await acquireKernelSession("http://kernel")).toHaveProperty("browserContextId", "context")
    await releaseKernelSession("http://kernel", identity.id)
    expect(fetch.mock.calls[1][0].toString()).toBe("http://kernel/api/browser/sessions/identity")
  })
  it("rejects an unavailable kernel instead of silently falling back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Chromium unavailable", { status: 503 })))
    await expect(acquireKernelSession("http://kernel")).rejects.toThrow()
  })
  it("rejects a session without its storage identity", async () => {
    const { browserContextId, ...missingIdentity } = identity
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(missingIdentity, { status: 201 })))
    await expect(acquireKernelSession("http://kernel")).rejects.toThrow()
  })
})
