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

  it("returns true on a 2xx response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch

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
