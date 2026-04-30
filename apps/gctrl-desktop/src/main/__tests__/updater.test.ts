import { describe, expect, it, vi } from "vitest"

import { startAutoUpdater, UPDATE_CHECK_INTERVAL_MS } from "../updater"

const baseDeps = (overrides: Partial<Parameters<typeof startAutoUpdater>[0]> = {}) => ({
  isPackaged: true,
  checkForUpdates: vi.fn(async () => {}),
  setInterval: vi.fn((_fn: () => void, _ms: number) => 1 as unknown),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...overrides,
})

describe("startAutoUpdater", () => {
  it("no-ops in dev mode and never schedules a check", () => {
    const deps = baseDeps({ isPackaged: false })
    startAutoUpdater(deps)
    expect(deps.checkForUpdates).not.toHaveBeenCalled()
    expect(deps.setInterval).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalled()
  })

  it("kicks off an initial check on startup when packaged", () => {
    const deps = baseDeps()
    startAutoUpdater(deps)
    expect(deps.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("schedules a recurring check at UPDATE_CHECK_INTERVAL_MS", () => {
    const setIntervalMock = vi.fn((_fn: () => void, _ms: number) => 1 as unknown)
    const deps = baseDeps({ setInterval: setIntervalMock })
    startAutoUpdater(deps)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    const [, ms] = setIntervalMock.mock.calls[0]!
    expect(ms).toBe(UPDATE_CHECK_INTERVAL_MS)
  })

  it("logs and swallows errors from checkForUpdates — never throws to the caller", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down")
    })
    const deps = baseDeps({ checkForUpdates: failing })

    expect(() => startAutoUpdater(deps)).not.toThrow()
    // Drain the rejected promise from the initial check.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.logger.error).toHaveBeenCalled()
  })

  it("the recurring tick also logs errors and never throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("flaky network")
    })
    let scheduled: (() => void) | null = null
    const errorLog = vi.fn()
    const deps = baseDeps({
      checkForUpdates: failing,
      setInterval: vi.fn((fn: () => void, _ms: number) => {
        scheduled = fn
        return 1 as unknown
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
    })

    startAutoUpdater(deps)
    expect(scheduled).not.toBeNull()
    expect(() => scheduled!()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Initial check + periodic check both should have logged errors.
    expect(errorLog.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
