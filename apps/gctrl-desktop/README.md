# gctrl-desktop

Electron-based macOS distribution for gctrl. Bundles the Rust kernel binary as a sidecar process inside a signed `.app`. macOS-first; Windows/Linux are out of scope for v1.

See the canonical specs:

- Architecture: [`vault/specs/architecture/apps/gctrl-desktop.md`](../../vault/specs/architecture/apps/gctrl-desktop.md)
- Implementation: [`vault/specs/implementation/apps/desktop-electron.md`](../../vault/specs/implementation/apps/desktop-electron.md)

## Status — being assembled in stacked PRs

| Slice | Adds | Status |
|---|---|---|
| **#1** | Kernel sidecar lifecycle module + tests | landing — this PR |
| **#2** | Electron main + preload + renderer wiring; local dev mode | next |
| **#3** | `electron-builder` config, hardened-runtime entitlements, `notarize.cjs`, `cargo-zigbuild` script | next |
| **#4** | `electron-updater` + `.github/workflows/release-mac.yml` + R2 upload | next |

## Layout

```
apps/gctrl-desktop/
├── src/
│   └── main/                        # Electron main process modules (Node)
│       └── kernel-sidecar.ts        # spawn / watchdog / shutdown — pure logic, port-injected
└── (electron entry, preload, renderer wiring — added in PR-2)
```

## Run tests

```sh
pnpm --filter gctrl-desktop test
pnpm --filter gctrl-desktop type-check
```
