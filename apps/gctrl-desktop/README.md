# gctrl-desktop

Electron-based macOS distribution for gctrl. Bundles the Rust kernel binary as a sidecar process inside a signed `.app`. macOS-first; Windows/Linux are out of scope for v1.

See the canonical specs:

- Architecture: [`vault/specs/architecture/apps/gctrl-desktop.md`](../../vault/specs/architecture/apps/gctrl-desktop.md)
- Implementation: [`vault/specs/implementation/apps/desktop-electron.md`](../../vault/specs/implementation/apps/desktop-electron.md)

## Status — being assembled in stacked PRs

| Slice | Adds | Status |
|---|---|---|
| **#1+2** | Scaffold, kernel sidecar lifecycle, Electron main/preload/menu, dev-mode renderer wiring | this PR |
| **#3** | `electron-builder` config, hardened-runtime entitlements, `notarize.cjs`, `cargo-zigbuild` script | next |
| **#4** | `electron-updater` + `.github/workflows/release-mac.yml` + R2 upload | next |

## Layout

```
apps/gctrl-desktop/
├── electron.vite.config.ts          # main + preload + renderer build targets
├── src/
│   ├── main/                        # Electron main process (Node)
│   │   ├── index.ts                 # app lifecycle, BrowserWindow, IPC handlers
│   │   ├── menu.ts                  # native macOS menu
│   │   ├── kernel-sidecar.ts        # lifecycle — pure logic, port-injected
│   │   ├── spawner.ts               # production Spawner (child_process.spawn)
│   │   ├── scheduler.ts             # production Scheduler (globalThis.setTimeout)
│   │   ├── paths.ts                 # kernel binary + data dir resolution
│   │   └── __tests__/               # vitest unit tests
│   ├── preload/
│   │   └── index.ts                 # contextBridge — narrow desktop-only surface
│   └── renderer/                    # placeholder for packaged-mode SPA (PR-3 wires gctrl-board)
│       ├── index.html
│       └── index.ts
```

## Dev workflow

This PR delivers dev mode only. Production packaging (signing, notarization, bundled sidecar) lands in PR-3.

In separate terminals:

```sh
# 1. Start the kernel daemon (writes to ~/.local/share/gctrl/)
gctrl serve

# 2. Start the gctrl-board Vite dev server (proxies /api → :4318)
pnpm --filter gctrl-board dev

# 3. Launch the desktop app — opens a window pointing at the dev URL above
pnpm --filter gctrl-desktop dev
```

Override the renderer URL if your gctrl-board dev server is on a different port:

```sh
GCTRL_DESKTOP_DEV_URL=http://localhost:5174 pnpm --filter gctrl-desktop dev
```

The kernel sidecar is intentionally **not spawned in dev** — running both `gctrl serve` and the Electron sidecar would double-bind port 4318. The lifecycle wiring is in place for packaged mode (PR-3).

## Run tests

```sh
pnpm --filter gctrl-desktop test          # vitest — 20 unit tests
pnpm --filter gctrl-desktop type-check    # tsc --noEmit
pnpm --filter gctrl-desktop build         # electron-vite build (smoke; no packaging yet)
```
