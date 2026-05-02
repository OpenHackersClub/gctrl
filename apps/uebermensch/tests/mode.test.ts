import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MODES, resolveMode } from "../src/lib/mode.js"

const setMode = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.UBER_MODE
  } else {
    process.env.UBER_MODE = value
  }
}

describe("resolveMode", () => {
  const original = process.env.UBER_MODE

  afterEach(() => {
    setMode(original)
  })

  it("defaults to local-kernel when UBER_MODE is unset", () => {
    setMode(undefined)
    expect(resolveMode()).toBe("local-kernel")
  })

  it("defaults to local-kernel when UBER_MODE is empty string", () => {
    setMode("")
    expect(resolveMode()).toBe("local-kernel")
  })

  it.each(MODES)("accepts valid mode %s", (mode) => {
    setMode(mode)
    expect(resolveMode()).toBe(mode)
  })

  it("throws with an actionable message for an unrecognised value", () => {
    setMode("cloud-direct")
    expect(() => resolveMode()).toThrow(/UBER_MODE="cloud-direct"/)
    expect(() => resolveMode()).toThrow(/local-kernel.*local-direct.*cloud-only/)
  })
})
