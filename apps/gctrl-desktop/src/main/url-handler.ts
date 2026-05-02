/**
 * `gctrl://` URL scheme handler.
 *
 * macOS LaunchServices routes `gctrl://...` clicks to this app via the
 * `open-url` event. This module is the single allowlist gate: only paths
 * matching one of the patterns below are dispatched — every other shape is
 * dropped with a debug log. There is no prefix-match, no fallback, no
 * shell-out.
 *
 * Allowed paths (regex-matched against the raw URL, NOT after URL
 * normalization — non-special schemes don't collapse `..`, so we anchor on
 * the literal string):
 *
 *   gctrl://focus/iterm2/<w?t?p?:UUIDv4>
 *   gctrl://focus/terminal/<window>/<tab>
 *   gctrl://focus/(ghostty|vscode|warp)/<token>
 *   gctrl://inbox/messages/<UUIDv4>
 *   gctrl://inbox/threads/<UUIDv4>
 *
 * The handler forwards focus URLs to `POST /api/comm/focus` on the local
 * kernel and routes inbox URLs into the in-app SPA. Both sides receive
 * already-validated input — defense in depth with the kernel-side validator
 * in `gctrl-mac-comm`.
 */

// --- pure parser (unit-testable; no IO) -------------------------------------

/**
 * Targets that take a single opaque session token (iTerm2 has its own
 * stricter shape; these all share the generic allowlist).
 */
const GENERIC_FOCUS_TARGETS = ["ghostty", "vscode", "warp"] as const
type GenericFocusTarget = (typeof GENERIC_FOCUS_TARGETS)[number]

const RE_FOCUS_ITERM2 =
  /^gctrl:\/\/focus\/iterm2\/(w[0-9]{1,4}t[0-9]{1,4}p[0-9]{1,4}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
const RE_FOCUS_TERMINAL = /^gctrl:\/\/focus\/terminal\/([0-9]{1,4})\/([0-9]{1,4})$/
const RE_FOCUS_GENERIC = /^gctrl:\/\/focus\/(ghostty|vscode|warp)\/([A-Za-z0-9_:.-]{1,64})$/
// UUIDv4 (case-insensitive). Strict positions: version nibble = 4, variant
// nibble in [89ab].
const RE_INBOX_MSG =
  /^gctrl:\/\/inbox\/messages\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/
const RE_INBOX_THREAD =
  /^gctrl:\/\/inbox\/threads\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/

export type ParsedGctrlUrl =
  | { kind: "focus-iterm2"; sessionId: string }
  | { kind: "focus-terminal"; windowId: string; tabId: string }
  | { kind: "focus-generic"; target: GenericFocusTarget; token: string }
  | { kind: "inbox-message"; id: string }
  | { kind: "inbox-thread"; id: string }

/**
 * Parse a `gctrl://` URL. Returns `null` for anything not in the allowlist
 * — including unknown paths, malformed UUIDs, missing components, and any
 * extraneous query-string or fragment.
 */
export function parseGctrlUrl(raw: string): ParsedGctrlUrl | null {
  // Reject anything that isn't a plain `gctrl://...` string.
  if (typeof raw !== "string" || raw.length > 512) return null
  // Disallow query strings and fragments — they have no semantic meaning in
  // this scheme and would only widen the parser's job.
  if (raw.includes("?") || raw.includes("#")) return null
  // Disallow embedded NUL / CR / LF — defense against terminal smuggling.
  if (/[\x00\r\n]/.test(raw)) return null

  let m: RegExpExecArray | null

  if ((m = RE_FOCUS_ITERM2.exec(raw))) {
    return { kind: "focus-iterm2", sessionId: m[1]! }
  }
  if ((m = RE_FOCUS_TERMINAL.exec(raw))) {
    return { kind: "focus-terminal", windowId: m[1]!, tabId: m[2]! }
  }
  if ((m = RE_FOCUS_GENERIC.exec(raw))) {
    const target = m[1] as GenericFocusTarget
    return { kind: "focus-generic", target, token: m[2]! }
  }
  if ((m = RE_INBOX_MSG.exec(raw))) {
    return { kind: "inbox-message", id: m[1]! }
  }
  if ((m = RE_INBOX_THREAD.exec(raw))) {
    return { kind: "inbox-thread", id: m[1]! }
  }

  return null
}

// --- dispatch (impure; takes injected deps for testing) ---------------------

/**
 * Body shape sent to `POST /api/comm/focus`.
 */
export type FocusRequestBody =
  | { target: "iterm2"; session_id: string }
  | { target: "terminal"; window_id: string; tab_id: string }
  | { target: GenericFocusTarget; session_id: string }

/**
 * Build the `/api/comm/focus` POST body from a parsed URL. Returns `null`
 * for inbox URLs (which don't hit the comm endpoint).
 */
export function focusBodyFor(parsed: ParsedGctrlUrl): FocusRequestBody | null {
  switch (parsed.kind) {
    case "focus-iterm2":
      return { target: "iterm2", session_id: parsed.sessionId }
    case "focus-terminal":
      return {
        target: "terminal",
        window_id: parsed.windowId,
        tab_id: parsed.tabId,
      }
    case "focus-generic":
      return { target: parsed.target, session_id: parsed.token }
    case "inbox-message":
    case "inbox-thread":
      return null
  }
}

/**
 * Build the SPA route a parsed inbox URL should navigate to. Returns `null`
 * for focus URLs.
 */
export function inboxRouteFor(parsed: ParsedGctrlUrl): string | null {
  switch (parsed.kind) {
    case "inbox-message":
      return `/inbox/messages/${parsed.id}`
    case "inbox-thread":
      return `/inbox/threads/${parsed.id}`
    case "focus-iterm2":
    case "focus-terminal":
    case "focus-generic":
      return null
  }
}

export interface UrlHandlerDeps {
  /** POST to the kernel; receives the `/api/comm/focus` URL and JSON body. */
  kernelPost: (path: string, body: unknown) => Promise<{ ok: boolean; status: number; bodyText: string }>
  /** Bring the main BrowserWindow to the foreground. */
  bringToFront: () => void
  /** Tell the renderer to navigate to a SPA route. */
  navigateSpa: (route: string) => void
  /** Logger; defaults to console. */
  logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * Result codes for telemetry / tests.
 */
export type HandleResult =
  | { kind: "dropped"; reason: "invalid-url" }
  | { kind: "focus-dispatched"; status: number; body: string }
  | { kind: "focus-failed"; reason: string }
  | { kind: "inbox-routed"; route: string }

export async function handleGctrlUrl(
  raw: string,
  deps: UrlHandlerDeps,
): Promise<HandleResult> {
  const log = deps.logger ?? console
  const parsed = parseGctrlUrl(raw)
  if (!parsed) {
    log.debug("[gctrl-desktop] dropped url (not in allowlist)", { raw })
    return { kind: "dropped", reason: "invalid-url" }
  }

  const body = focusBodyFor(parsed)
  if (body !== null) {
    try {
      const res = await deps.kernelPost("/api/comm/focus", body)
      return { kind: "focus-dispatched", status: res.status, body: res.bodyText }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn("[gctrl-desktop] kernel focus call failed", { raw, reason })
      return { kind: "focus-failed", reason }
    }
  }

  const route = inboxRouteFor(parsed)
  if (route !== null) {
    deps.bringToFront()
    deps.navigateSpa(route)
    return { kind: "inbox-routed", route }
  }

  // Unreachable — every parsed kind handled above. Belt-and-braces.
  log.warn("[gctrl-desktop] parsed URL had no dispatch path", { parsed })
  return { kind: "dropped", reason: "invalid-url" }
}
