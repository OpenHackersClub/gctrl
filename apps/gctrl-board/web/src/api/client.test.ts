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

  // macOS driver routes live at the kernel root (`/api/macos/*`), not
  // under `/api/board`. Regression guard: the renderer must hit the
  // driver-macos LKM directly.
  it("macos.health hits /api/macos/health (not /api/board/...)", async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            os: "macos",
            version: "15.2",
            capabilities: [],
            permissions: { accessibility: "not_requested" },
            version_skew: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    setDesktop({ apiBase: "http://127.0.0.1:4318" })
    await api.macos.health()
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:4318/api/macos/health")
  })

  it("macos.name posts to /api/macos/spaces/:id/name with JSON body", async () => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    setDesktop(undefined)
    await api.macos.name(3, "inbox")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/macos/spaces/3/name")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(init?.body as string)).toEqual({ name: "inbox" })
  })

  it("macos.unname DELETEs /api/macos/spaces/:id/name", async () => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    setDesktop(undefined)
    await api.macos.unname(7)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/macos/spaces/7/name")
    expect(init?.method).toBe("DELETE")
  })

  it("macos.promptAccessibility POSTs /api/macos/permissions/accessibility/prompt", async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessibility: "denied" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    setDesktop(undefined)
    const res = await api.macos.promptAccessibility()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/macos/permissions/accessibility/prompt")
    expect(init?.method).toBe("POST")
    expect(res.accessibility).toBe("denied")
  })
})
