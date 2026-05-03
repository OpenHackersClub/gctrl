/**
 * Pure builders + predicates for the gctrl `gctrl://` deep-link surface.
 *
 * These are intentionally pure (no React, no fetch) so the inbox UI's
 * Focus-button gating, the deep-link href construction, and the capability
 * probe interpretation can all be unit-tested without DOM or network.
 *
 * The kernel side has its own canonical validators (`gctrl-mac-comm`) and
 * `gctrl-desktop` does another allowlist parse on `open-url`. This file is
 * the third independent boundary — the SPA only renders an anchor that is
 * guaranteed to match the allowlist, so a malformed payload lands as a
 * hidden button rather than a clickable broken URL.
 */

import type { CommCapabilities, TerminalApp, TerminalContext } from "../types"

const ITERM2_SESSION_RE =
  /^w[0-9]{1,4}t[0-9]{1,4}p[0-9]{1,4}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const GENERIC_SESSION_RE = /^[A-Za-z0-9_:.-]{1,64}$/
const INDEX_RE = /^[0-9]{1,4}$/

/**
 * Build the `gctrl://focus/...` URL for a captured terminal context. Returns
 * `null` if the context lacks the fields the target needs, or if any field
 * fails the per-target shape check.
 *
 * No throws; renders gate on the return value being a string.
 */
export function buildFocusUrl(t: TerminalContext | undefined | null): string | null {
  if (!t || t.app === "unknown") return null

  switch (t.app) {
    case "iterm2": {
      const sid = t.session_id
      if (!sid || !ITERM2_SESSION_RE.test(sid)) return null
      return `gctrl://focus/iterm2/${sid}`
    }
    case "terminal": {
      const w = t.window_id
      const tab = t.tab_id
      if (!w || !INDEX_RE.test(w)) return null
      if (!tab || !INDEX_RE.test(tab)) return null
      return `gctrl://focus/terminal/${w}/${tab}`
    }
    case "ghostty":
    case "vscode":
    case "warp": {
      const sid = t.session_id
      if (!sid || !GENERIC_SESSION_RE.test(sid)) return null
      return `gctrl://focus/${t.app}/${sid}`
    }
  }
}

/**
 * Whether the inbox should render a Focus button at all, given the
 * terminal-context attached to a message and the current `/api/comm/
 * capabilities` snapshot.
 *
 * Independent of `buildFocusUrl` — `shouldShowFocus` answers "does the UI
 * have any business showing the affordance"; `buildFocusUrl` answers "what
 * URL does the click open." The button only renders when both return
 * truthy.
 */
export function shouldShowFocus(
  caps: CommCapabilities | null,
  terminal: TerminalContext | undefined,
): boolean {
  if (!terminal || terminal.app === "unknown") return false
  if (!caps) return false
  // Hide entirely on non-macOS — the kernel routes return 501 there.
  if (caps.os !== "macos") return false
  // The capabilities snapshot's `terminals` is the source of truth for
  // which adapters compile in this build.
  if (!caps.terminals.includes(terminal.app)) return false
  // `automation_granted` is `null | undefined` until the user grants on
  // first prompt; we still show the button (the click triggers the prompt
  // path) and only hide on an explicit `false`.
  if (caps.automation_granted === false) return false
  return true
}

/**
 * Human-readable label for a terminal app. Keep in sync with the kernel's
 * `TerminalApp::label()`.
 */
export function labelFor(app: TerminalApp): string {
  switch (app) {
    case "iterm2":
      return "iTerm2"
    case "terminal":
      return "Terminal"
    case "ghostty":
      return "Ghostty"
    case "vscode":
      return "VS Code"
    case "warp":
      return "Warp"
    case "unknown":
      return "unknown"
  }
}

/**
 * HTML-escape a string so it can be safely interpolated into a DOM
 * attribute (e.g., `title="..."`). React already escapes text-content but
 * NOT attribute values constructed via template strings; this is the
 * defense for cases like `<a title={`${app} · ${cwd}`}>`.
 *
 * The kernel intake validator already rejects most dangerous `cwd` shapes,
 * so this is belt-and-braces.
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * The CLI command that's a fallback for users without gctrl-desktop
 * installed. Surfaced in the "no protocol handler" toast with a copy
 * button.
 */
export function buildFocusCliCommand(t: TerminalContext): string | null {
  if (!t || t.app === "unknown") return null
  switch (t.app) {
    case "iterm2":
    case "ghostty":
    case "vscode":
    case "warp":
      if (!t.session_id) return null
      return `gctrl terminal focus --target ${t.app} --session ${t.session_id}`
    case "terminal":
      if (!t.window_id || !t.tab_id) return null
      return `gctrl terminal focus --target terminal --window ${t.window_id} --tab ${t.tab_id}`
  }
}
