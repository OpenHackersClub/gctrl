// Flags the document for Electron-specific styling (notably: leave space
// for macOS traffic-light buttons and make the header draggable). Pure
// over a target element so the test can assert the class transitions
// without touching the real DOM.

export type DesktopShim = { apiBase?: string }

export const isDesktopHost = (host: { desktop?: DesktopShim }): boolean =>
  typeof host.desktop?.apiBase === "string" && host.desktop.apiBase.length > 0

export const applyDesktopClass = (
  root: { classList: { add: (c: string) => void; remove: (c: string) => void } },
  host: { desktop?: DesktopShim },
): void => {
  if (isDesktopHost(host)) root.classList.add("is-electron")
  else root.classList.remove("is-electron")
}
