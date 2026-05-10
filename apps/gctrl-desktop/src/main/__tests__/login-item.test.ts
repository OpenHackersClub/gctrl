import { describe, expect, it, vi } from "vitest"

import {
  ensureLoginItemRegistered,
  type LoginItemPorts,
  type LoginItemSettings,
} from "../login-item"

type Fakes = {
  ports: LoginItemPorts
  set: ReturnType<typeof vi.fn>
  writeMarker: ReturnType<typeof vi.fn>
  current: { value: LoginItemSettings }
  marker: { exists: boolean }
}

const makeFakes = (overrides: {
  isPackaged?: boolean
  markerExists?: boolean
  initialOpenAtLogin?: boolean
}): Fakes => {
  const current = { value: { openAtLogin: overrides.initialOpenAtLogin ?? false } }
  const marker = { exists: overrides.markerExists ?? false }
  const set = vi.fn((settings: LoginItemSettings) => {
    current.value = settings
  })
  const writeMarker = vi.fn(() => {
    marker.exists = true
  })
  return {
    ports: {
      isPackaged: overrides.isPackaged ?? true,
      markerExists: () => marker.exists,
      writeMarker,
      getCurrent: () => current.value,
      set,
      logger: { info: () => {}, warn: () => {} },
    },
    set,
    writeMarker,
    current,
    marker,
  }
}

describe("ensureLoginItemRegistered", () => {
  it("registers + writes marker on first packaged launch when not yet enabled", () => {
    const f = makeFakes({})

    const outcome = ensureLoginItemRegistered(f.ports)

    expect(outcome).toBe("registered")
    expect(f.set).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: false })
    expect(f.writeMarker).toHaveBeenCalledOnce()
    expect(f.current.value.openAtLogin).toBe(true)
  })

  it("skips in dev mode (not packaged) — never touches Login Items in a debug session", () => {
    const f = makeFakes({ isPackaged: false })

    const outcome = ensureLoginItemRegistered(f.ports)

    expect(outcome).toBe("skipped-not-packaged")
    expect(f.set).not.toHaveBeenCalled()
    expect(f.writeMarker).not.toHaveBeenCalled()
  })

  it("respects a user who disabled the Login Item — marker present, never re-enables", () => {
    // Setup: prior install registered (marker exists) but user later unticked
    // gctrl in System Settings → Login Items, so getCurrent reports false.
    const f = makeFakes({ markerExists: true, initialOpenAtLogin: false })

    const outcome = ensureLoginItemRegistered(f.ports)

    expect(outcome).toBe("skipped-marker-present")
    expect(f.set).not.toHaveBeenCalled()
    // Marker already exists; we must not rewrite it (would mask future logic
    // that distinguishes "first launch" by absence).
    expect(f.writeMarker).not.toHaveBeenCalled()
    expect(f.current.value.openAtLogin).toBe(false)
  })

  it("treats already-enabled-without-marker as one-time bootstrap: writes the marker, no toggle", () => {
    const f = makeFakes({ markerExists: false, initialOpenAtLogin: true })

    const outcome = ensureLoginItemRegistered(f.ports)

    expect(outcome).toBe("skipped-already-registered")
    expect(f.set).not.toHaveBeenCalled()
    expect(f.writeMarker).toHaveBeenCalledOnce()
  })

  it("is idempotent across consecutive calls within one session", () => {
    const f = makeFakes({})

    expect(ensureLoginItemRegistered(f.ports)).toBe("registered")
    expect(ensureLoginItemRegistered(f.ports)).toBe("skipped-marker-present")
    expect(ensureLoginItemRegistered(f.ports)).toBe("skipped-marker-present")

    expect(f.set).toHaveBeenCalledTimes(1)
    expect(f.writeMarker).toHaveBeenCalledTimes(1)
  })
})
