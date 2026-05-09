---
name: reinstall-mac-app
description: Build the gctrl-desktop Electron app from the current branch and replace /Applications/gctrl.app with the fresh build. Quits the running app first, builds via `pnpm release:mac`, copies the new .app, and relaunches. Usage - /reinstall-mac-app [--branch <ref>] [--skip-pull] (defaults to the current HEAD; passes --branch to checkout that ref first; --skip-pull leaves the working tree alone).
---

End-to-end "rebuild and replace `/Applications/gctrl.app`" workflow. The user runs this when they want their installed Mac app to reflect the latest code — typically after a kernel or renderer change has merged to main.

Five phases: **prep → build → quit → install → verify**. Each phase has its own failure mode; surface errors to the user before proceeding rather than carrying broken artifacts forward.

## Inputs

The user's argument string is optional. Parse:

- `--branch <ref>` (or `-b <ref>`) — checkout this ref before building. If the worktree is already on the ref, no-op. If dirty, abort with a clear message rather than stashing.
- `--skip-pull` — don't run `git fetch` / sync; build whatever HEAD points at.

Default: build the current HEAD as-is, but `git fetch origin` so the user knows whether they're behind.

## Phase 1 — Prep

1. Confirm we're inside a gctrl checkout: `apps/gctrl-desktop/package.json` exists. If not, abort.
2. Confirm Apple targets installed: `rustup target list --installed | grep apple-darwin` returns both `aarch64-apple-darwin` and `x86_64-apple-darwin`. If missing, run `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
3. Confirm `lipo` and `cargo` on PATH (the universal2 build script needs both).
4. Unless `--skip-pull`: `git fetch origin` and report `git log --oneline HEAD..origin/<base>` so the user knows whether the install will be ahead/behind main.
5. If `--branch <ref>` was passed: `git checkout <ref>` (only if working tree is clean).
6. `pnpm install --frozen-lockfile` (cheap; no-ops if nothing changed).

Don't run any tests in this phase — the install is a hot path. Tests belong in CI.

## Phase 2 — Build

Run from `apps/gctrl-desktop/`:

```sh
pnpm release:mac
```

This expands to:
1. `pnpm build:kernel` — universal2 `gctrld` via vanilla cargo + lipo (~6 min).
2. `pnpm build` — electron-vite bundles main + preload (~30s).
3. `pnpm build:renderer-spa` — gctrl-board SPA, copied to `out/renderer/` (~10s).
4. `electron-builder --mac` — packs `release/mac-arm64/gctrl.app` and a .dmg (~2 min).

**Critical:** run this in the background (`run_in_background: true`) and tee stdout to `.tmp/build-<timestamp>.log` so the user can tail it. Don't poll inline — the runtime will notify on completion.

`APPLE_API_KEY` is rarely set locally, so notarization auto-skips per `apps/gctrl-desktop/build/notarize.cjs`. The .app is therefore unsigned — fine for personal install, NOT for distribution. Mention this in the final summary so the user isn't surprised when Gatekeeper challenges them on first launch.

If the build fails:
- `cargo` compile errors → surface the first error verbatim and stop. Don't try auto-fixes; the user wants the install, not a code change.
- `electron-builder` errors → most commonly missing icons/entitlements. Surface the message verbatim.
- DO NOT proceed to Phase 3 with stale artifacts.

## Phase 3 — Quit

The new .app can't replace a running one. Before installing:

1. Quit the running GUI: `osascript -e 'tell application "gctrl" to quit'`. Tolerate "process not found" silently.
2. Kill stragglers (sidecar `gctrld` won't always die with the parent): `pkill -f "gctrl.app/Contents"` and `pkill -x gctrld`. Both are idempotent — exit code 1 just means "nothing to kill".
3. Wait up to 3s for `lsof | grep "/Applications/gctrl.app"` to drain. If anything is still holding files, surface it and ask the user before forcing.

## Phase 4 — Install

1. Locate the new .app: `apps/gctrl-desktop/release/mac-arm64/gctrl.app` (Apple Silicon hosts) or `release/mac/gctrl.app` (Intel). Universal2 builds emit `mac-universal/`. Check all three.
2. Sanity-check the bundle:
   - `defaults read <new-app>/Contents/Info CFBundleVersion` returns a non-empty string.
   - `<new-app>/Contents/MacOS/gctrl` exists and is executable.
   - `<new-app>/Contents/Resources/kernel/gctrl-kernel` exists (the bundled sidecar — the renderer can't reach the kernel without it).
3. Replace: `rm -rf /Applications/gctrl.app && cp -R <new-app> /Applications/`. If `rm` needs sudo, surface that; don't auto-escalate.
4. Strip the macOS quarantine xattr so first launch doesn't fight Gatekeeper: `xattr -dr com.apple.quarantine /Applications/gctrl.app`. Tolerate "no such xattr" silently.

If the build was unsigned, also note: first launch via Finder will need right-click → Open. Launching via `open -a` (next phase) bypasses that, so it works without manual intervention.

## Phase 5 — Verify

1. Launch: `open -a /Applications/gctrl.app`.
2. Wait up to 30s for the kernel sidecar to bind: poll `curl -fsS http://127.0.0.1:4318/health` every 1s.
3. Once healthy, hit `curl -fsS http://127.0.0.1:4318/api/macos/health` and pretty-print the JSON. Confirm `os == "macos"` and report `permissions.accessibility` so the user knows whether the AX prompt CTA will be visible.
4. If the kernel never binds: tail `~/Library/Logs/gctrl/*.log` (or wherever the desktop wires logs in this version) and surface the last 30 lines.

## Final summary

Output:

```
## Reinstall Summary

**Built from**: <commit SHA> (<branch>)
**Installed at**: /Applications/gctrl.app
**Notarized**: yes / no (skipped: APPLE_API_KEY not set)
**Kernel health**: ✓ http://127.0.0.1:4318/health responding
**macOS driver**: os=macos · permissions.accessibility=<state> · capabilities=<list>

### Next steps
- [ ] If `permissions.accessibility != "granted"`, open Settings → macOS Spaces in the app and click Grant Accessibility.
- [ ] Re-grant Accessibility if you replaced the binary — TCC pins by code-signature/path, and a fresh unsigned build is treated as a different process.
```

Keep it under 15 lines.

## Guardrails

- Never auto-escalate to sudo. If `/Applications/gctrl.app` can't be replaced as the current user, surface and ask.
- Never skip the Quit phase — overwriting a running .app produces a half-broken bundle that crashes on next launch.
- Never silently swallow build errors. The user wanted the install, not a misleading "OK" on a failed build.
- Preserve the previous `.app` only if the user passes `--keep-old`; otherwise the simplest contract ("the install reflects the build") wins.
- Don't run any GUI apps that require user interaction (e.g., don't open System Settings) — surface the action in the summary instead.
- This skill is macOS-only. If `uname` reports anything else, abort with a message rather than failing partway through.
