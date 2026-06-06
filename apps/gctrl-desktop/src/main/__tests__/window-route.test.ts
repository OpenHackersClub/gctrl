import { describe, expect, it } from "vitest"

import { sanitizeWindowRoute } from "../window-route"

describe("sanitizeWindowRoute", () => {
  it("accepts SPA routes", () => {
    expect(sanitizeWindowRoute("/projects/BACK")).toBe("/projects/BACK")
    expect(sanitizeWindowRoute("/projects/BACK/gantt")).toBe("/projects/BACK/gantt")
    expect(sanitizeWindowRoute("/inbox/threads/0b9e8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "/inbox/threads/0b9e8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    )
    expect(sanitizeWindowRoute("/analytics/usage")).toBe("/analytics/usage")
  })

  it("trims surrounding whitespace", () => {
    expect(sanitizeWindowRoute("  /projects/BACK ")).toBe("/projects/BACK")
  })

  it("maps default-window requests to undefined", () => {
    expect(sanitizeWindowRoute(undefined)).toBeUndefined()
    expect(sanitizeWindowRoute("")).toBeUndefined()
    expect(sanitizeWindowRoute("/")).toBeUndefined()
  })

  it("rejects non-strings", () => {
    expect(sanitizeWindowRoute(42)).toBeUndefined()
    expect(sanitizeWindowRoute({ route: "/projects/BACK" })).toBeUndefined()
    expect(sanitizeWindowRoute(["/projects/BACK"])).toBeUndefined()
  })

  it("rejects URLs and protocol-relative paths", () => {
    expect(sanitizeWindowRoute("https://evil.example")).toBeUndefined()
    expect(sanitizeWindowRoute("//evil.example/path")).toBeUndefined()
    expect(sanitizeWindowRoute("gctrl://focus/iterm2/abc")).toBeUndefined()
    expect(sanitizeWindowRoute("file:///etc/passwd")).toBeUndefined()
  })

  it("rejects relative paths and unsafe characters", () => {
    expect(sanitizeWindowRoute("projects/BACK")).toBeUndefined()
    expect(sanitizeWindowRoute("/projects/BACK?x=1")).toBeUndefined()
    expect(sanitizeWindowRoute("/projects/BACK#frag")).toBeUndefined()
    expect(sanitizeWindowRoute("/projects/<script>")).toBeUndefined()
    expect(sanitizeWindowRoute("/projects/BACK BACK")).toBeUndefined()
  })

  it("rejects absurdly long routes", () => {
    expect(sanitizeWindowRoute(`/${"a".repeat(600)}`)).toBeUndefined()
  })
})
