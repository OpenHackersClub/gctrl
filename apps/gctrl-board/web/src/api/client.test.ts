import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "./client"

type DesktopShim = { apiBase?: string }

const setDesktop = (value: DesktopShim | undefined) => {
  ;(globalThis as unknown as { desktop?: DesktopShim }).desktop = value
}

describe("api client base URL resolution", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    setDesktop(undefined)
  })

  it("issues a relative request when no desktop bridge is present (web context)", async () => {
    setDesktop(undefined)
    await api.projects.list()
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/board/projects")
  })

  it("prepends desktop.apiBase when the Electron preload exposes one", async () => {
    setDesktop({ apiBase: "http://127.0.0.1:4318" })
    await api.projects.list()
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:4318/api/board/projects")
  })

  it("never produces a file:// URL for inbox endpoints", async () => {
    setDesktop({ apiBase: "http://127.0.0.1:4318" })
    await api.inbox.stats()
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toMatch(/^file:/)
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:4318\//)
  })

  it("strips a trailing slash on apiBase to avoid a double slash", async () => {
    setDesktop({ apiBase: "http://127.0.0.1:4318/" })
    await api.projects.list()
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:4318/api/board/projects")
  })
})
