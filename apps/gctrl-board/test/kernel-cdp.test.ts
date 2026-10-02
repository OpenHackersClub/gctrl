import { afterEach, describe, expect, it, vi } from "vitest"
import { KernelCDPObserver } from "../tests/acceptance/fixtures/kernel-cdp"

const request = {
  requestId: "r", url: "http://app/api/board/issues", method: "GET", status: 200,
  responseHeaders: { "content-type": "application/json" }, startedAt: "2026-10-02T00:00:00Z",
  finishedAt: "2026-10-02T00:00:01Z", failed: false,
}
const consoleEntry = (seq: number, text: string) => ({ seq, text, level: "error", kind: "exception", ts: "2026-10-02T00:00:00Z" })
afterEach(() => vi.unstubAllGlobals())
describe("kernel recorder acceptance observer", () => {
  it("queries the controlling identity through the shell and keeps response headers", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([request]))
    vi.stubGlobal("fetch", fetch)
    const observer = new KernelCDPObserver("http://kernel", "actual-identity", { send: vi.fn() })
    expect((await observer.getApiRequests())[0].responseHeaders).toEqual(request.responseHeaders)
    expect(fetch.mock.calls[0][0].toString()).toBe("http://kernel/api/browser/sessions/actual-identity/network")
  })
  it("clears console by sequence without erasing another consumer's records", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([consoleEntry(0, "before")]))
      .mockResolvedValueOnce(Response.json([consoleEntry(0, "before"), consoleEntry(1, "after")]))
    vi.stubGlobal("fetch", fetch)
    const observer = new KernelCDPObserver("http://kernel", "actual-identity", { send: vi.fn() })
    await observer.clearConsole()
    expect((await observer.getConsoleErrors()).map(entry => entry.text)).toEqual(["after"])
  })
  it("samples metrics from the bound page's CDP session", async () => {
    const send = vi.fn().mockResolvedValue({ metrics: [{ name: "Documents", value: 3 }] })
    const observer = new KernelCDPObserver("http://kernel", "actual-identity", { send })
    expect(await observer.getDocumentCount()).toBe(3)
    expect(send).toHaveBeenCalledWith("Performance.getMetrics")
  })
})
