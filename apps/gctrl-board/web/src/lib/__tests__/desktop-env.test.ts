import { describe, expect, it } from "vitest"

import { applyDesktopClass, isDesktopHost } from "../desktop-env"

const fakeRoot = () => {
  const classes = new Set<string>()
  return {
    classList: {
      add: (c: string) => {
        classes.add(c)
      },
      remove: (c: string) => {
        classes.delete(c)
      },
    },
    has: (c: string) => classes.has(c),
  }
}

describe("isDesktopHost", () => {
  it("is true when desktop.apiBase is a non-empty string", () => {
    expect(isDesktopHost({ desktop: { apiBase: "http://127.0.0.1:4318" } })).toBe(true)
  })

  it("is false when desktop is missing", () => {
    expect(isDesktopHost({})).toBe(false)
  })

  it("is false when apiBase is empty", () => {
    expect(isDesktopHost({ desktop: { apiBase: "" } })).toBe(false)
  })
})

describe("applyDesktopClass", () => {
  it("adds is-electron when host has the bridge", () => {
    const root = fakeRoot()
    applyDesktopClass(root, { desktop: { apiBase: "http://127.0.0.1:4318" } })
    expect(root.has("is-electron")).toBe(true)
  })

  it("removes is-electron when host lacks the bridge", () => {
    const root = fakeRoot()
    root.classList.add("is-electron")
    applyDesktopClass(root, {})
    expect(root.has("is-electron")).toBe(false)
  })
})
