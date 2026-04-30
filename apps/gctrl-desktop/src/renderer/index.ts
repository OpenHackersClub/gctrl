// Placeholder renderer entry. PR-3 replaces this with logic that boots the
// bundled gctrl-board SPA from `apps/gctrl-board/dist-web/`. For now this file
// only exists so `electron-vite build` produces a valid renderer chunk; the
// dev-mode flow loads `GCTRL_DESKTOP_DEV_URL` (defaults to the gctrl-board
// Vite server on :5173) directly via `BrowserWindow.loadURL`.

export {}
