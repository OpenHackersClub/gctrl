// Native macOS menu bar. Without an explicit menu, Electron falls back to a
// generic default that hides the standard macOS chrome (Edit copy/paste,
// Window list, Services, etc.). This rebuilds the standard set so the app
// feels native.

import { Menu, type MenuItemConstructorOptions, app } from "electron"

export interface AppMenuDeps {
  /** Open a fresh window at the default view (File → New Window, ⌘N). */
  readonly onNewWindow: () => void
}

export const buildAppMenu = (deps: AppMenuDeps): Menu => {
  const isMac = process.platform === "darwin"

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => deps.onNewWindow(),
        },
        { type: "separator" },
        ...(isMac
          ? ([{ role: "close" }] satisfies MenuItemConstructorOptions[])
          : ([{ role: "quit" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "delete" },
              { type: "separator" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
