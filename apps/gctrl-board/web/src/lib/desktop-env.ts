// Flags the document for Electron-specific styling (notably: leave space
// for macOS traffic-light buttons and make the header draggable). Pure
// over a target element so the test can assert the class transitions
// without touching the real DOM.

export type DesktopShim = {
  apiBase?: string
  initialRoute?: string
  openWindow?: (route?: string) => Promise<void>
}

export const isDesktopHost = (host: { desktop?: DesktopShim }): boolean =>
  typeof host.desktop?.apiBase === "string" && host.desktop.apiBase.length > 0

/**
 * The SPA path this window should boot on. In packaged Electron the SPA is
 * loaded from `file://`, so `location.pathname` is the bundle path — the
 * desktop shell passes the intended route through the preload bridge
 * instead (one window per project view). On the web, and in desktop windows
 * opened without an explicit view, this falls through to the real pathname.
 */
export const resolveInitialPath = (
  host: { desktop?: DesktopShim },
  pathname: string,
): string => {
  const route = host.desktop?.initialRoute
  if (typeof route === "string" && route.startsWith("/") && !route.startsWith("//")) {
    return route
  }
  return pathname
}

export const applyDesktopClass = (
  root: { classList: { add: (c: string) => void; remove: (c: string) => void } },
  host: { desktop?: DesktopShim },
): void => {
  if (isDesktopHost(host)) root.classList.add("is-electron")
  else root.classList.remove("is-electron")
}
