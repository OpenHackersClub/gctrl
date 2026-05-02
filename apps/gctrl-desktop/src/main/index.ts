// Electron main process entry. Owns app lifecycle, window management, the
// kernel sidecar (in packaged mode), and a narrow IPC surface exposed through
// the preload bridge.

import { app, BrowserWindow, Menu, ipcMain, shell } from "electron"
import electronUpdater from "electron-updater"
const { autoUpdater } = electronUpdater
import path from "node:path"
import { fileURLToPath } from "node:url"

import { KernelSidecar } from "./kernel-sidecar"
import { buildAppMenu } from "./menu"
import { resolveKernelBinPath, resolveKernelDataDir } from "./paths"
import { createScheduler } from "./scheduler"
import { createSpawner } from "./spawner"
import { startAutoUpdater } from "./updater"
import { handleGctrlUrl, type UrlHandlerDeps } from "./url-handler"

const KERNEL_PORT = 4318
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let sidecar: KernelSidecar | undefined
let mainWindow: BrowserWindow | undefined

// Buffer URLs that arrive before the BrowserWindow is ready (cold-launch
// path: `open gctrl://...` starts the app, fires `open-url`, then the
// window is created). Drained on `did-finish-load`.
const pendingUrls: string[] = []

const createSidecar = (): KernelSidecar | undefined => {
  // Only spawn the kernel sidecar in packaged mode. In dev, contributors run
  // `gctrld serve` (or the launchd agent) separately to avoid double-binding
  // port 4318.
  if (!app.isPackaged) return undefined

  const ctx = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    appRoot: __dirname,
    devKernelPath: process.env.GCTRL_KERNEL_DEV_PATH,
  }

  return new KernelSidecar(
    {
      binPath: resolveKernelBinPath(ctx),
      port: KERNEL_PORT,
      dataDir: resolveKernelDataDir(ctx),
    },
    {
      spawner: createSpawner(),
      scheduler: createScheduler(),
      logger: console,
    },
  )
}

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset",
    // Pin traffic lights to a known offset so the SPA's CSS reservation
    // (`.is-electron nav { padding-top: 40px }`) reliably clears them.
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: "#0b0b0e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "../preload/index.js"),
      // Pass the kernel sidecar's base URL into preload's argv so the SPA
      // (loaded from `file://` in packaged mode) can reach the loopback API
      // instead of resolving relative `/api/...` paths against `file:///`.
      additionalArguments: [`--gctrl-api-base=http://127.0.0.1:${KERNEL_PORT}`],
    },
  })

  if (app.isPackaged) {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"))
  } else {
    // Dev mode: point at the gctrl-board Vite dev server. The default
    // matches gctrl-board's `web/vite.config.ts` (port 4200); override
    // via GCTRL_DESKTOP_DEV_URL when running an alternate renderer.
    const devUrl = process.env.GCTRL_DESKTOP_DEV_URL ?? "http://localhost:4200"
    void win.loadURL(devUrl)
  }

  // Reserve space for macOS traffic-light buttons. Injected from main so it
  // applies regardless of what classes the renderer toggles — the prior
  // attempt to do this from `main.tsx` via a `.is-electron` class kept
  // losing to Tailwind's utilities.
  win.webContents.on("did-finish-load", () => {
    void win.webContents.insertCSS(
      `nav.flex.flex-col { padding-top: 44px !important; }
       header { -webkit-app-region: drag; }
       header button, header a, header input, header [role="button"], header select { -webkit-app-region: no-drag; }
       nav { -webkit-app-region: drag; }
       nav button, nav a, nav [role="button"] { -webkit-app-region: no-drag; }`,
    )
  })

  // Open external links in the system browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  // Drain any URLs that arrived before this window existed.
  win.webContents.on("did-finish-load", () => {
    const urls = pendingUrls.splice(0)
    for (const url of urls) void dispatchGctrlUrl(url)
  })

  return win
}

ipcMain.handle("open-external", (_event, url: string) => shell.openExternal(url))
ipcMain.handle("show-in-finder", (_event, p: string) => {
  shell.showItemInFolder(p)
})
ipcMain.handle("app-version", () => app.getVersion())

// --- gctrl:// URL scheme ----------------------------------------------------

// Register `gctrl://` once on app startup (idempotent). LaunchServices then
// routes any `gctrl://...` click — from a browser, an inbox anchor, or
// `open(1)` — to this app via the `open-url` event.
if (!app.isDefaultProtocolClient("gctrl")) {
  app.setAsDefaultProtocolClient("gctrl")
}

const urlHandlerDeps = (): UrlHandlerDeps => ({
  kernelPost: async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${KERNEL_PORT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, status: res.status, bodyText: await res.text() }
  },
  bringToFront: () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  },
  navigateSpa: (route) => {
    // Renderer subscribes to `gctrl-navigate` via the preload bridge.
    if (mainWindow) mainWindow.webContents.send("gctrl-navigate", route)
  },
  logger: console,
})

async function dispatchGctrlUrl(url: string): Promise<void> {
  const deps = urlHandlerDeps()
  await handleGctrlUrl(url, deps)
}

app.on("open-url", (event, url) => {
  event.preventDefault()
  // If the BrowserWindow isn't ready yet, buffer the URL — the cold-launch
  // path fires `open-url` before any window exists.
  if (!mainWindow || !mainWindow.webContents || mainWindow.webContents.isLoading()) {
    pendingUrls.push(url)
    return
  }
  void dispatchGctrlUrl(url)
})

void app.whenReady().then(() => {
  Menu.setApplicationMenu(buildAppMenu())
  sidecar = createSidecar()
  sidecar?.start()
  mainWindow = createWindow()

  startAutoUpdater({
    isPackaged: app.isPackaged,
    // `checkForUpdatesAndNotify` returns the resolved manifest or null; we
    // don't need the value here, only the success/failure signal.
    checkForUpdates: () => autoUpdater.checkForUpdatesAndNotify().then(() => undefined),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    logger: console,
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  // On macOS apps stay running until the user explicitly quits.
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  sidecar?.stop()
})
