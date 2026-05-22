// Electron main process entry. Owns app lifecycle, window management, the
// kernel sidecar (in packaged mode), and a narrow IPC surface exposed through
// the preload bridge.

import { app, BrowserWindow, dialog, Menu, ipcMain, shell } from "electron"
import electronUpdater from "electron-updater"
const { autoUpdater } = electronUpdater
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createHealthCheck } from "./health-check"
import { KernelSidecar } from "./kernel-sidecar"
import { ensureLoginItemRegistered } from "./login-item"
import { buildAppMenu } from "./menu"
import { resolveKernelBinPath, resolveKernelDataDir, resolveKernelVaultDir } from "./paths"
import { createScheduler } from "./scheduler"
import { createSpawner } from "./spawner"
import { startAutoUpdater } from "./updater"
import { handleGctrlUrl, type UrlHandlerDeps } from "./url-handler"
import { resolveVaultDir, type VaultPicker } from "./vault-config"

const KERNEL_PORT = 4318
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let sidecar: KernelSidecar | undefined
let mainWindow: BrowserWindow | undefined

// Buffer URLs that arrive before the BrowserWindow is ready (cold-launch
// path: `open gctrl://...` starts the app, fires `open-url`, then the
// window is created). Drained on `did-finish-load`.
const pendingUrls: string[] = []

/**
 * Native folder picker shown on first launch. Lets the user choose a vault
 * root or create a new one. Mirrors Obsidian's "Open folder as vault"
 * affordance — sandboxed file:// renderer can't do this from the web side,
 * so it must happen in main.
 */
const nativeVaultPicker: VaultPicker = async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose your gctrl vault",
    message:
      "Pick a folder where your projects, briefs, and tasks live. " +
      "You can change this later in Settings.",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

const createSidecar = async (): Promise<KernelSidecar | undefined> => {
  // Only spawn the kernel sidecar in packaged mode. In dev, contributors run
  // `gctrld serve` separately. The singleton probe inside KernelSidecar would
  // catch the dev-mode case anyway (it'd defer to the contributor's daemon),
  // but skipping the construction is cheaper and avoids stray probe traffic.
  if (!app.isPackaged) return undefined

  const ctx = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    appRoot: __dirname,
    homedir: os.homedir(),
    platform: process.platform,
    devKernelPath: process.env.GCTRL_KERNEL_DEV_PATH,
  }

  const dataDir = resolveKernelDataDir(ctx)
  // Resolution order: GCTRL_BOARD_DIR env > persisted choice in
  // `vault-config.json` > native folder picker > default fallback. On
  // first launch the picker fires so the user lands on a real vault
  // instead of an empty `<userData>/vault/` they didn't ask for.
  const vaultDir = await resolveVaultDir({
    userDataPath: ctx.userDataPath,
    defaultVaultDir: resolveKernelVaultDir(ctx),
    envOverride: process.env.GCTRL_BOARD_DIR,
    picker: nativeVaultPicker,
  })

  // Ensure both the kernel data dir and the vault root exist before the
  // sidecar starts — DuckDB's path must resolve, and the kernel's file
  // watcher canonicalizes the vault root (silent skip if missing).
  // `recursive: true` is idempotent; safe to run on every launch.
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(vaultDir, { recursive: true })

  return new KernelSidecar(
    {
      binPath: resolveKernelBinPath(ctx),
      port: KERNEL_PORT,
      dataDir,
      vaultDir,
    },
    {
      spawner: createSpawner(),
      scheduler: createScheduler(),
      // Defers to any gctrl daemon already on :4318 — brew/cargo install,
      // a `gctrld serve` left running, or a previous app session. Without
      // this the bundled kernel races for the port and the DuckDB writer
      // lock and one of them crash-loops.
      healthCheck: createHealthCheck(),
      logger: console,
    },
  )
}

const LOGIN_ITEM_MARKER = "login-item-registered"

const registerLoginItem = (): void => {
  const markerPath = path.join(app.getPath("userData"), LOGIN_ITEM_MARKER)
  ensureLoginItemRegistered({
    isPackaged: app.isPackaged,
    markerExists: () => existsSync(markerPath),
    // Marker write failures (full disk, sandboxed permissions, locked
    // userData) MUST NOT crash the app: setLoginItemSettings has already
    // run, so the worst case is that next launch hits the
    // `skipped-already-registered` branch and self-corrects via the
    // marker bootstrap path.
    writeMarker: () => {
      try {
        writeFileSync(markerPath, new Date().toISOString())
      } catch (err) {
        console.warn("[login-item] failed to write marker file:", err)
      }
    },
    getCurrent: () => app.getLoginItemSettings(),
    set: (settings) => app.setLoginItemSettings(settings),
    logger: console,
  })
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
      // A sandboxed renderer can only load a CommonJS preload — an ESM
      // preload silently fails to execute. electron-vite is configured
      // `formats: ["cjs"]` for preload, which emits `out/preload/index.cjs`.
      // The `.cjs` here must match the bundler output exactly — the
      // build-wiring test asserts agreement and that it is not ESM.
      preload: path.join(__dirname, "../preload/index.cjs"),
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
  if (!mainWindow?.webContents || mainWindow.webContents.isLoading()) {
    pendingUrls.push(url)
    return
  }
  void dispatchGctrlUrl(url)
})

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildAppMenu())
  registerLoginItem()
  // Vault picker (when needed) blocks here on purpose — the kernel
  // sidecar must know where to watch before it spawns. Subsequent
  // launches read the persisted choice and skip the dialog entirely.
  sidecar = await createSidecar()
  void sidecar?.start()
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
