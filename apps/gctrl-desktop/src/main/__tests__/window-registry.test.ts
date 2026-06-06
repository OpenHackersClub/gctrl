import { describe, expect, it } from "vitest"

import { createWindowRegistry } from "../window-registry"

describe("createWindowRegistry", () => {
  it("starts empty", () => {
    const reg = createWindowRegistry<string>()
    expect(reg.isEmpty()).toBe(true)
    expect(reg.mostRecentlyFocused()).toBeUndefined()
  })

  it("returns the last added window as most recently focused", () => {
    const reg = createWindowRegistry<string>()
    reg.add("a")
    reg.add("b")
    expect(reg.mostRecentlyFocused()).toBe("b")
    expect(reg.isEmpty()).toBe(false)
  })

  it("promotes a window on focus", () => {
    const reg = createWindowRegistry<string>()
    reg.add("a")
    reg.add("b")
    reg.noteFocused("a")
    expect(reg.mostRecentlyFocused()).toBe("a")
  })

  it("falls back to the next most recent when the front window closes", () => {
    const reg = createWindowRegistry<string>()
    reg.add("a")
    reg.add("b")
    reg.add("c")
    reg.noteFocused("b")
    reg.remove("b")
    expect(reg.mostRecentlyFocused()).toBe("c")
    reg.remove("c")
    expect(reg.mostRecentlyFocused()).toBe("a")
    reg.remove("a")
    expect(reg.isEmpty()).toBe(true)
  })

  it("does not duplicate a window added twice", () => {
    const reg = createWindowRegistry<string>()
    reg.add("a")
    reg.add("a")
    reg.remove("a")
    expect(reg.isEmpty()).toBe(true)
  })

  it("ignores removal of an unknown window", () => {
    const reg = createWindowRegistry<string>()
    reg.add("a")
    reg.remove("ghost")
    expect(reg.mostRecentlyFocused()).toBe("a")
  })
})
