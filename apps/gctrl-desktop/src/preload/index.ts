// Preload bridge — runs in an isolated context between main and renderer.
//
// The renderer talks to the kernel directly via `fetch('http://127.0.0.1:4318')`,
// so this surface is intentionally narrow: only desktop-shell capabilities the
// renderer cannot accomplish from the web platform alone (open external URLs,
// reveal a path in Finder, read the app version for diagnostics).
//
// Add new IPC channels with care — every method here is a hole in the
// renderer's sandbox. If a feature is achievable with `fetch`, do it there.

import { contextBridge, ipcRenderer } from "electron"

declare global {
  // Surface this in TS when consumers (the bundled SPA) want to opt into
  // desktop-only features. Outside Electron the namespace is undefined and
  // callers must feature-detect.
  interface Window {
    desktop?: {
      readonly openExternal: (url: string) => Promise<void>
      readonly showInFinder: (path: string) => Promise<void>
      readonly appVersion: () => Promise<string>
    }
  }
}

contextBridge.exposeInMainWorld("desktop", {
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  showInFinder: (path: string) => ipcRenderer.invoke("show-in-finder", path),
  appVersion: () => ipcRenderer.invoke("app-version"),
})
