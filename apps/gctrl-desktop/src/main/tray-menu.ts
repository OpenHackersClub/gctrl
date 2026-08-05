// Pure builder for the menu-bar tray menu. Returns plain
// `MenuItemConstructorOptions` so it can be unit-tested without `electron`
// (the import is type-only and erased at build time). The Electron-dependent
// wiring — creating the `Tray`, polling the kernel, the fallback blocker —
// lives in `index.ts`.

import type { MenuItemConstructorOptions } from "electron"

export interface TrayMenuState {
  /** Whether the Mac is currently being kept awake. */
  readonly awake: boolean
  /**
   * Whether the kernel power capability is available. When false the tray is
   * driving Electron's local `powerSaveBlocker` as a fallback, surfaced as a
   * hint in the menu.
   */
  readonly supported: boolean
  /**
   * Label of the active timed-awake window (e.g. "1 hour"), or null/undefined
   * when awake is indefinite (or off).
   */
  readonly timedLabel?: string | null
}

export interface TrayMenuHandlers {
  readonly onToggle: () => void
  readonly onTimed: (durationMs: number, label: string) => void
  readonly onOpen: () => void
  readonly onQuit: () => void
}

/** Preset timed-awake windows offered in the menu. */
export const TIMED_DURATIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "4 hours", ms: 4 * 60 * 60 * 1000 },
]

export const trayTooltip = (state: TrayMenuState): string =>
  state.awake ? "gctrl — keeping your Mac awake" : "gctrl — Mac can sleep"

export const buildTrayMenuTemplate = (
  state: TrayMenuState,
  handlers: TrayMenuHandlers,
): MenuItemConstructorOptions[] => {
  const items: MenuItemConstructorOptions[] = []

  if (state.awake && state.timedLabel) {
    items.push(
      { label: `Awake for ${state.timedLabel}`, enabled: false },
      { type: "separator" },
    )
  }

  items.push({
    label: "Keep Mac awake",
    type: "checkbox",
    checked: state.awake,
    click: () => handlers.onToggle(),
  })

  for (const d of TIMED_DURATIONS) {
    items.push({
      label: `Awake for ${d.label}`,
      click: () => handlers.onTimed(d.ms, d.label),
    })
  }

  items.push(
    { type: "separator" },
    { label: "Open gctrl", click: () => handlers.onOpen() },
    { label: "Quit gctrl", click: () => handlers.onQuit() },
  )

  if (!state.supported) {
    items.splice(
      0,
      0,
      { label: "Kernel power unavailable — using app fallback", enabled: false },
      { type: "separator" },
    )
  }

  return items
}
