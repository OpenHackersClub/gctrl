import { describe, expect, it } from "vitest"

import { parseInitialRoute } from "../initial-route"

describe("parseInitialRoute", () => {
  it("extracts the flag value", () => {
    expect(
      parseInitialRoute(["--type=renderer", "--gctrl-initial-route=/projects/BACK"]),
    ).toBe("/projects/BACK")
  })

  it("returns undefined when the flag is absent", () => {
    expect(parseInitialRoute(["--type=renderer"])).toBeUndefined()
    expect(parseInitialRoute([])).toBeUndefined()
  })

  it("rejects values that are not app paths", () => {
    expect(parseInitialRoute(["--gctrl-initial-route="])).toBeUndefined()
    expect(parseInitialRoute(["--gctrl-initial-route=projects/BACK"])).toBeUndefined()
    expect(parseInitialRoute(["--gctrl-initial-route=//evil.example"])).toBeUndefined()
    expect(parseInitialRoute(["--gctrl-initial-route=https://evil.example"])).toBeUndefined()
  })

  it("takes the first matching flag", () => {
    expect(
      parseInitialRoute([
        "--gctrl-initial-route=/projects/A",
        "--gctrl-initial-route=/projects/B",
      ]),
    ).toBe("/projects/A")
  })
})
