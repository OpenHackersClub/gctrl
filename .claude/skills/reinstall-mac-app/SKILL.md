---
name: reinstall-mac-app
description: Build the gctrl-desktop Electron app from the current branch and replace /Applications/gctrl.app with the fresh build. Quits the running app first, builds via `pnpm release:mac`, copies the new .app, and relaunches. Usage - /reinstall-mac-app [--branch <ref>] [--skip-pull] (defaults to the current HEAD; passes --branch to checkout that ref first; --skip-pull leaves the working tree alone).
---

End-to-end "rebuild and replace `/Applications/gctrl.app`" workflow. The user runs this when they want their installed Mac app to reflect the latest code — typically after a kernel or renderer change has merged to main.

Six phases: **prep → build → quit → validate → install → verify**. Each phase has its own failure mode; surface errors to the user before proceeding rather than carrying broken artifacts forward.

The **validate** phase smoke-tests the freshly built `.app` in place — launching it from `release/mac-arm64/`, polling the kernel sidecar, and hitting the two endpoints the renderer bootstraps from (`/api/analytics`, `/api/board/projects`) — *before* `/Applications/gctrl.app` is touched. A broken build must never replace a working install. If validation fails, abort and leave the existing install alone.

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

## Phase 4 — Validate (in place, before install)

The whole point of this phase: catch a broken build *before* it replaces a working `/Applications/gctrl.app`. Run the freshly built `.app` from its build directory, prove the kernel sidecar is healthy and the renderer's bootstrap endpoints respond, then quit it. If anything below fails, **abort and do not proceed to Phase 5** — the existing install stays untouched.

1. **Locate the new .app**: `apps/gctrl-desktop/release/mac-arm64/gctrl.app` (Apple Silicon hosts) or `release/mac/gctrl.app` (Intel). Universal2 builds emit `mac-universal/`. Check all three. Save the path as `NEW_APP` for the rest of this phase.
2. **Bundle sanity-check**:
   - `defaults read $NEW_APP/Contents/Info CFBundleVersion` returns a non-empty string.
   - `$NEW_APP/Contents/MacOS/gctrl` exists and is executable.
   - `$NEW_APP/Contents/Resources/kernel/gctrl-kernel` exists and is executable (the bundled sidecar — the renderer can't reach the kernel without it).
3. **Strip quarantine on the build output** so Gatekeeper doesn't intercept the test launch: `xattr -dr com.apple.quarantine $NEW_APP`. Tolerate "no such xattr" silently.
4. **Confirm :4318 is free** (Phase 3 should have done this — re-check): `lsof -iTCP:4318 -sTCP:LISTEN` returns nothing. If anything is still bound, abort with the holder's PID.
5. **Launch in place**: `open -na $NEW_APP`. The `-n` forces a fresh instance even if a stale one is registered.
6. **Wait for kernel bind** (up to 30s, poll every 1s): `curl -fsS http://127.0.0.1:4318/health`. Must return JSON with `status: "ok"`.
7. **Hit the renderer's bootstrap endpoints** — these are the calls the user's renderer makes on first paint, and the same calls that produced "Failed to load overview" / "Is the kernel running on :4318?" in earlier broken builds:
   - `curl -fsS http://127.0.0.1:4318/api/macos/health` — must return JSON with `os == "macos"`. Report `permissions.accessibility` for the summary.
   - `curl -fsS http://127.0.0.1:4318/api/analytics` — must return HTTP 200 with parseable JSON (this is the analytics-overview endpoint the AnalyticsPage fetches; if it 404s or 500s, the bundled kernel is missing routes).
   - `curl -fsS http://127.0.0.1:4318/api/board/projects` — must return HTTP 200 with a JSON array (the board renderer's first call; if it errors, the bundled DB or driver-board is wrong).
   - Any non-2xx, parse failure, or timeout (>5s per endpoint) → abort.
8. **Quit the test instance** so Phase 5 can replace files cleanly: `osascript -e 'tell application "gctrl" to quit'`, then `pkill -f "$NEW_APP/Contents"` and `pkill -x gctrld` (idempotent). Wait up to 3s for `:4318` to free.

If anything in steps 1–7 fails:
- Surface the failing endpoint / error verbatim.
- Tail `~/Library/Logs/gctrl/*.log` and surface the last 30 lines.
- Do NOT proceed to Phase 5.
- Tell the user the existing `/Applications/gctrl.app` is unchanged.

## Phase 5 — Install

By the time we get here, Phase 4 has proven the new bundle is healthy. The install is now a near-mechanical replace:

1. Replace: `rm -rf /Applications/gctrl.app && cp -R $NEW_APP /Applications/`. If `rm` needs sudo, surface that; don't auto-escalate.
2. Strip the macOS quarantine xattr on the installed copy: `xattr -dr com.apple.quarantine /Applications/gctrl.app`. Tolerate "no such xattr" silently.

If the build was unsigned, also note: first launch via Finder will need right-click → Open. Launching via `open -a` (next phase) bypasses that, so it works without manual intervention.

## Phase 6 — Verify

Validation already happened in Phase 4 against the same artifact. This phase is a sanity check that the *copy* in `/Applications/` boots identically.

1. Launch: `open -a /Applications/gctrl.app`.
2. Wait up to 30s for the kernel sidecar to bind: poll `curl -fsS http://127.0.0.1:4318/health` every 1s.
3. Re-hit the bootstrap endpoints (same as Phase 4 step 7) on the installed copy: `/api/macos/health`, `/api/analytics`, `/api/board/projects`. All three must return 200. If any regress between Phase 4 and Phase 6, the install is broken — surface the diff and tell the user (don't try to "fix" it).
4. If the kernel never binds: tail `~/Library/Logs/gctrl/*.log` (or wherever the desktop wires logs in this version) and surface the last 30 lines.

## Final summary

Output:

```
## Reinstall Summary

**Built from**: <commit SHA> (<branch>)
**Validation**: ✓ smoke-tested in-place before install (/health, /api/macos/health, /api/analytics, /api/board/projects all 200)
**Installed at**: /Applications/gctrl.app
**Notarized**: yes / no (skipped: APPLE_API_KEY not set)
**Kernel health**: ✓ http://127.0.0.1:4318/health responding
**macOS driver**: os=macos · permissions.accessibility=<state> · capabilities=<list>

### Next steps
- [ ] If `permissions.accessibility != "granted"`, open Settings → macOS Spaces in the app and click Grant Accessibility.
- [ ] Re-grant Accessibility if you replaced the binary — TCC pins by code-signature/path, and a fresh unsigned build is treated as a different process.
```

Keep it under 16 lines.

## Guardrails

- **Never replace `/Applications/gctrl.app` if Phase 4 validation failed.** A working install is more valuable than a fresh broken one. Abort, surface the failure, leave the existing install alone.
- Never auto-escalate to sudo. If `/Applications/gctrl.app` can't be replaced as the current user, surface and ask.
- Never skip the Quit phase — overwriting a running .app produces a half-broken bundle that crashes on next launch.
- Never silently swallow build errors. The user wanted the install, not a misleading "OK" on a failed build.
- Preserve the previous `.app` only if the user passes `--keep-old`; otherwise the simplest contract ("the install reflects the build") wins.
- Don't run any GUI apps that require user interaction (e.g., don't open System Settings) — surface the action in the summary instead.
- This skill is macOS-only. If `uname` reports anything else, abort with a message rather than failing partway through.
