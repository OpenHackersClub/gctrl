import { describe, expect, it, vi } from "vitest"

import {
  TIMED_DURATIONS,
  buildTrayMenuTemplate,
  trayTooltip,
  type TrayMenuHandlers,
} from "../tray-menu"

const noopHandlers = (): TrayMenuHandlers => ({
  onToggle: vi.fn(),
  onTimed: vi.fn(),
  onOpen: vi.fn(),
  onQuit: vi.fn(),
})

const labels = (items: ReturnType<typeof buildTrayMenuTemplate>): string[] =>
  items.map((i) => i.label).filter((l): l is string => typeof l === "string")

describe("buildTrayMenuTemplate", () => {
  it("reflects the awake state in the checkbox", () => {
    const off = buildTrayMenuTemplate(
      { awake: false, supported: true },
      noopHandlers(),
    )
    const toggleOff = off.find((i) => i.label === "Keep Mac awake")
    expect(toggleOff?.type).toBe("checkbox")
    expect(toggleOff?.checked).toBe(false)

    const on = buildTrayMenuTemplate({ awake: true, supported: true }, noopHandlers())
    expect(on.find((i) => i.label === "Keep Mac awake")?.checked).toBe(true)
  })

  it("offers each preset timed-awake window", () => {
    const items = buildTrayMenuTemplate(
      { awake: false, supported: true },
      noopHandlers(),
    )
    for (const d of TIMED_DURATIONS) {
      expect(labels(items)).toContain(`Awake for ${d.label}`)
    }
  })

  it("shows the active timed window only when awake", () => {
    const active = buildTrayMenuTemplate(
      { awake: true, supported: true, timedLabel: "1 hour" },
      noopHandlers(),
    )
    expect(labels(active)).toContain("Awake for 1 hour")
    // The info row is disabled (it's a status line, not an action).
    expect(active[0]?.enabled).toBe(false)

    // Timed label present but not awake → no status row.
    const inactive = buildTrayMenuTemplate(
      { awake: false, supported: true, timedLabel: "1 hour" },
      noopHandlers(),
    )
    expect(inactive[0]?.label).toBe("Keep Mac awake")
  })

  it("surfaces the local-fallback hint when the kernel is unsupported", () => {
    const items = buildTrayMenuTemplate(
      { awake: true, supported: false },
      noopHandlers(),
    )
    expect(items[0]?.label).toContain("fallback")
    expect(items[0]?.enabled).toBe(false)
  })

  it("wires the toggle and quit handlers", () => {
    const handlers = noopHandlers()
    const items = buildTrayMenuTemplate({ awake: false, supported: true }, handlers)
    const click = (label: string) =>
      // electron's click signature has args; we invoke with none in the test.
      (items.find((i) => i.label === label)?.click as (() => void) | undefined)?.()

    click("Keep Mac awake")
    click("Quit gctrl")
    click("Open gctrl")
    click(`Awake for ${TIMED_DURATIONS[0]!.label}`)

    expect(handlers.onToggle).toHaveBeenCalledOnce()
    expect(handlers.onQuit).toHaveBeenCalledOnce()
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    expect(handlers.onTimed).toHaveBeenCalledWith(
      TIMED_DURATIONS[0]!.ms,
      TIMED_DURATIONS[0]!.label,
    )
  })
})

describe("trayTooltip", () => {
  it("describes the current state", () => {
    expect(trayTooltip({ awake: true, supported: true })).toMatch(/awake/i)
    expect(trayTooltip({ awake: false, supported: true })).toMatch(/sleep/i)
  })
})
