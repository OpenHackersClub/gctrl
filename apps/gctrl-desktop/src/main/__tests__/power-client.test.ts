import { describe, expect, it, vi } from "vitest"

import {
  POWER_PATH,
  fetchPowerStatus,
  type PowerStatus,
  setPreventSleep,
} from "../power-client"

const STATUS: PowerStatus = {
  supported: true,
  active: true,
  kind: "display",
  reason: "gctrl kernel is running",
}

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response

describe("fetchPowerStatus", () => {
  it("returns the parsed status on a 200", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(STATUS))
    const res = await fetchPowerStatus("http://127.0.0.1:4318", fetchImpl)
    expect(res).toEqual({ ok: true, status: STATUS })
    expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4318${POWER_PATH}`)
  })

  it("reports an error on a non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, false, 503))
    const res = await fetchPowerStatus("http://127.0.0.1:4318", fetchImpl)
    expect(res).toEqual({ ok: false, error: "power status HTTP 503" })
  })

  it("reports an error when fetch throws (kernel down)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED")
    })
    const res = await fetchPowerStatus("http://127.0.0.1:4318", fetchImpl)
    expect(res).toEqual({ ok: false, error: "ECONNREFUSED" })
  })
})

describe("setPreventSleep", () => {
  it("POSTs enable/kind/reason and returns the new status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ...STATUS, active: false }),
    )
    const res = await setPreventSleep(
      "http://127.0.0.1:4318",
      { enable: false, kind: "display", reason: "gctrl tray" },
      fetchImpl,
    )
    expect(res.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`http://127.0.0.1:4318${POWER_PATH}`)
    expect(init?.method).toBe("POST")
    expect(JSON.parse(init?.body as string)).toEqual({
      enable: false,
      kind: "display",
      reason: "gctrl tray",
    })
  })

  it("surfaces a non-2xx as an error result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, false, 501))
    const res = await setPreventSleep(
      "http://127.0.0.1:4318",
      { enable: true },
      fetchImpl,
    )
    expect(res).toEqual({ ok: false, error: "set power HTTP 501" })
  })
})
