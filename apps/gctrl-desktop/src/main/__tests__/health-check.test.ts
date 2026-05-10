import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createHealthCheck } from "../health-check"
import type { SidecarConfig } from "../kernel-sidecar"

const config: SidecarConfig = {
  binPath: "/unused",
  port: 4318,
  dataDir: "/unused",
}

describe("createHealthCheck (production fetch adapter)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("returns true on a 2xx response with the gctrl /health body shape", async () => {
    const gctrlHealthBody = JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime_seconds: 42,
      storage: {},
    })
    globalThis.fetch = vi.fn(
      async () =>
        new Response(gctrlHealthBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch

    const probe = createHealthCheck()
    await expect(probe(config)).resolves.toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("returns false on a non-2xx response (something else is squatting on :4318)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as typeof fetch

    const probe = createHealthCheck()
    await expect(probe(config)).resolves.toBe(false)
  })

  it("returns false when a foreign service responds 200 but the body isn't gctrl-shaped", async () => {
    // A misconfigured Vite/Python http.server/etc. squatting on :4318 would
    // happily 200 on /health. Without body validation, the bundled sidecar
    // would defer to it forever and autostart would silently brick.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "hello from another service" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch

    const probe = createHealthCheck()
    await expect(probe(config)).resolves.toBe(false)
  })

  it("returns false when /health returns 200 with a non-JSON body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("plain text not json", { status: 200 }),
    ) as typeof fetch

    const probe = createHealthCheck()
    await expect(probe(config)).resolves.toBe(false)
  })

  it("returns false when fetch throws (connection refused, no listener)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED")
    }) as typeof fetch

    const probe = createHealthCheck()
    await expect(probe(config)).resolves.toBe(false)
  })

  it("returns false when the probe times out (slow squatter on the port)", async () => {
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        }),
    ) as typeof fetch

    const probe = createHealthCheck()
    const promise = probe(config)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe(false)
  })
})
