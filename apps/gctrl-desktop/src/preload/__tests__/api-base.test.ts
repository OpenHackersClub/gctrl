import { describe, expect, it } from "vitest"

import { parseApiBase } from "../api-base"

describe("parseApiBase", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parseApiBase(["--other=1", "foo"])).toBeUndefined()
  })

  it("extracts the URL when the flag is present", () => {
    expect(parseApiBase(["--gctrl-api-base=http://127.0.0.1:4318"])).toBe(
      "http://127.0.0.1:4318",
    )
  })

  it("ignores an empty value", () => {
    expect(parseApiBase(["--gctrl-api-base="])).toBeUndefined()
  })

  it("returns the first match when the flag appears more than once", () => {
    expect(
      parseApiBase([
        "--gctrl-api-base=http://127.0.0.1:4318",
        "--gctrl-api-base=http://example.invalid",
      ]),
    ).toBe("http://127.0.0.1:4318")
  })

  it("works alongside unrelated argv entries", () => {
    expect(
      parseApiBase([
        "/path/to/electron",
        "--enable-features=Foo",
        "--gctrl-api-base=http://127.0.0.1:4318",
        "--remote-debugging-port=0",
      ]),
    ).toBe("http://127.0.0.1:4318")
  })
})
