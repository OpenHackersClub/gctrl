// Fallback renderer entry. The packaged build replaces this whole bundle
// with the gctrl-board SPA via `pnpm build:renderer-spa` (which RM's
// out/renderer/ and copies apps/gctrl-board/dist-web/ in its place). This
// file only ships when packaging skipped that step; dev mode bypasses it
// entirely via `BrowserWindow.loadURL(GCTRL_DESKTOP_DEV_URL)`.

export {}
