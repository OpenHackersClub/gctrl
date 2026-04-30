# gctrl-desktop

Electron-based macOS distribution for gctrl. Bundles the Rust kernel binary as a sidecar process inside a signed `.app`. macOS-first; Windows/Linux are out of scope for v1.

See the canonical specs:

- Architecture: [`vault/specs/architecture/apps/gctrl-desktop.md`](../../vault/specs/architecture/apps/gctrl-desktop.md)
- Implementation: [`vault/specs/implementation/apps/desktop-electron.md`](../../vault/specs/implementation/apps/desktop-electron.md)

## Status — assembled across the PR stack

| Slice | Adds | PR |
|---|---|---|
| **#1+2** | Scaffold, kernel sidecar lifecycle, Electron main/preload/menu, dev-mode wiring | merged |
| **#3+4** | `electron-builder` config, hardened-runtime entitlements, `@electron/notarize` afterSign, `cargo-zigbuild` universal2 binary, gctrl-board SPA bundled into the renderer slot, `electron-updater`, `release-mac.yml` CI workflow | this PR |

## Layout

```
apps/gctrl-desktop/
├── electron.vite.config.ts          # main + preload + renderer build targets
├── build/
│   ├── entitlements.mac.plist       # hardened-runtime entitlements
│   └── notarize.cjs                 # electron-builder afterSign — @electron/notarize
├── scripts/
│   └── build-kernel-universal.sh    # cargo-zigbuild → universal2 kernel binary
├── resources/
│   └── kernel/                      # universal2 binary staged here for extraResources (gitignored)
├── src/
│   ├── main/                        # Electron main process (Node)
│   │   ├── index.ts                 # app lifecycle, BrowserWindow, IPC, updater
│   │   ├── menu.ts                  # native macOS menu
│   │   ├── kernel-sidecar.ts        # lifecycle — pure logic, port-injected
│   │   ├── spawner.ts               # production Spawner (child_process.spawn)
│   │   ├── scheduler.ts             # production Scheduler (globalThis.setTimeout)
│   │   ├── paths.ts                 # kernel binary + data dir resolution
│   │   ├── updater.ts               # auto-updater logic — port-injected
│   │   └── __tests__/               # vitest unit tests
│   ├── preload/
│   │   └── index.ts                 # contextBridge — narrow desktop-only surface
│   └── renderer/                    # placeholder; release replaces with gctrl-board's dist-web
│       ├── index.html
│       └── index.ts
```

## Dev workflow

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

The kernel sidecar is intentionally **not spawned in dev** — running both `gctrl serve` and the Electron sidecar would double-bind port 4318. The lifecycle wiring is in place for packaged mode.

## Release

Local release flow (requires Apple Developer ID cert + App Store Connect API key in env):

```sh
pnpm --filter gctrl-desktop release:mac
```

Under the hood:

1. `pnpm build:kernel` — `cargo-zigbuild` produces a `universal2-apple-darwin` kernel binary at `resources/kernel/gctrl-kernel`.
2. `pnpm build` — `electron-vite build` emits `out/main`, `out/preload`, `out/renderer` (placeholder).
3. `pnpm build:renderer-spa` — builds `gctrl-board` and overwrites `out/renderer` with its production SPA bundle.
4. `electron-builder --mac` — signs every binary in the `.app`, runs the `afterSign` hook to notarize via `notarytool`, staples the ticket, and emits a universal `.dmg` plus an `electron-updater` manifest under `release/`.

### Required env vars

| Var | Purpose |
|---|---|
| `CSC_LINK` | Base64-encoded `.p12` from Developer ID Application cert |
| `CSC_KEY_PASSWORD` | Password for the `.p12` |
| `APPLE_API_KEY` | Path to App Store Connect API key (`.p8`) |
| `APPLE_API_KEY_ID` | Key ID from App Store Connect |
| `APPLE_API_ISSUER` | Issuer ID (UUID) |
| `APPLE_TEAM_ID` | 10-character Apple Team ID |

When these are absent (e.g. local smoke build), `electron-builder` produces an unsigned `.app` and `notarize.cjs` self-skips with a clear log line. The artifact is **not distributable** in that mode but still verifies the bundling pipeline.

### CI release workflow

`.github/workflows/release-mac.yml` triggers on `v*` tags or via manual dispatch. Steps:

1. Provision Node, pnpm, Rust toolchain (both `apple-darwin` targets), zig, `cargo-zigbuild`.
2. Run the same `release:mac` flow.
3. Verify Gatekeeper acceptance (`codesign --verify --deep`, `spctl -a -t exec`).
4. Attach the `.dmg` to the GitHub Release for the tag.
5. Publish the `electron-updater` manifest (`latest-mac.yml`) + DMG + blockmap to R2 if credentials are configured.

Required GitHub Actions secrets for a fully signed release:

- `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` (optional — when absent, falls back to GitHub Releases)

## Run tests

```sh
pnpm --filter gctrl-desktop test          # vitest — 25 unit tests
pnpm --filter gctrl-desktop type-check    # tsc --noEmit
pnpm --filter gctrl-desktop build         # electron-vite build (smoke; main + preload + renderer placeholder)
pnpm --filter gctrl-desktop pack          # electron-builder --dir (smoke; no signing/notarization)
```
