// Electron main process entry. Owns app lifecycle, window management, the
// kernel sidecar (in packaged mode), and a narrow IPC surface exposed through
// the preload bridge.

import { app, BrowserWindow, Menu, ipcMain, shell } from "electron"
import { autoUpdater } from "electron-updater"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { KernelSidecar } from "./kernel-sidecar"
import { buildAppMenu } from "./menu"
import { resolveKernelBinPath, resolveKernelDataDir } from "./paths"
import { createScheduler } from "./scheduler"
import { createSpawner } from "./spawner"
import { startAutoUpdater } from "./updater"

const KERNEL_PORT = 4318
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let sidecar: KernelSidecar | undefined
let mainWindow: BrowserWindow | undefined

const createSidecar = (): KernelSidecar | undefined => {
  // Only spawn the kernel sidecar in packaged mode. In dev, contributors run
  // `gctrl serve` separately to avoid double-binding port 4318. The lifecycle
  // module is still wired here so PR-3's packaging brings it online with no
  // further changes to this file.
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
    backgroundColor: "#0b0b0e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  })

  if (app.isPackaged) {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"))
  } else {
    // Dev mode: point at the gctrl-board Vite dev server (or whatever
    // GCTRL_DESKTOP_DEV_URL specifies). PR-3 wires the bundled SPA path.
    const devUrl = process.env.GCTRL_DESKTOP_DEV_URL ?? "http://localhost:5173"
    void win.loadURL(devUrl)
  }

  // Open external links in the system browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  return win
}

ipcMain.handle("open-external", (_event, url: string) => shell.openExternal(url))
ipcMain.handle("show-in-finder", (_event, p: string) => {
  shell.showItemInFolder(p)
})
ipcMain.handle("app-version", () => app.getVersion())

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
