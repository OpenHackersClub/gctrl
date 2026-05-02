// Preload bridge — runs in an isolated context between main and renderer.
//
// The renderer talks to the kernel directly via `fetch('http://127.0.0.1:4318')`,
// so this surface is intentionally narrow: only desktop-shell capabilities the
// renderer cannot accomplish from the web platform alone (open external URLs,
// reveal a path in Finder, read the app version for diagnostics) plus the
// kernel's base URL so the SPA can build absolute fetch URLs.
//
// Add new IPC channels with care — every method here is a hole in the
// renderer's sandbox. If a feature is achievable with `fetch`, do it there.

import { contextBridge, ipcRenderer } from "electron"

import { parseApiBase } from "./api-base"

declare global {
  // Surface this in TS when consumers (the bundled SPA) want to opt into
  // desktop-only features. Outside Electron the namespace is undefined and
  // callers must feature-detect.
  interface Window {
    desktop?: {
      readonly apiBase?: string
      readonly openExternal: (url: string) => Promise<void>
      readonly showInFinder: (path: string) => Promise<void>
      readonly appVersion: () => Promise<string>
    }
  }
}

// Main injects `--gctrl-api-base=http://127.0.0.1:<port>` via
// `webPreferences.additionalArguments`. Without it the SPA's relative
// `/api/...` paths resolve against the `file://` document origin and fail.
const apiBase = parseApiBase(process.argv)

contextBridge.exposeInMainWorld("desktop", {
  apiBase,
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  showInFinder: (path: string) => ipcRenderer.invoke("show-in-finder", path),
  appVersion: () => ipcRenderer.invoke("app-version"),
})
