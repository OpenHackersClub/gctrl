import { describe, expect, it, vi } from "vitest"

import {
  focusBodyFor,
  handleGctrlUrl,
  inboxRouteFor,
  parseGctrlUrl,
  type UrlHandlerDeps,
} from "../url-handler"

const VALID_ITERM2_ID = "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765"
const VALID_UUID = "11111111-2222-4333-8444-555555555555"

describe("parseGctrlUrl — focus paths", () => {
  it("accepts the canonical iTerm2 shape", () => {
    expect(parseGctrlUrl(`gctrl://focus/iterm2/${VALID_ITERM2_ID}`)).toEqual({
      kind: "focus-iterm2",
      sessionId: VALID_ITERM2_ID,
    })
  })

  it("rejects iTerm2 path with non-UUID tail", () => {
    expect(parseGctrlUrl("gctrl://focus/iterm2/w0t0p0:not-a-uuid")).toBeNull()
  })

  it("rejects iTerm2 path missing window/tab/pane prefix", () => {
    expect(
      parseGctrlUrl(`gctrl://focus/iterm2/${VALID_UUID}`), // bare UUID, no w0t0p0
    ).toBeNull()
  })

  it("rejects iTerm2 path with a quote-injection attempt in the session id", () => {
    const evil = "gctrl://focus/iterm2/w0t0p0:X\" & do shell script \"rm -rf /\""
    expect(parseGctrlUrl(evil)).toBeNull()
  })

  it("accepts Apple Terminal window/tab indices", () => {
    expect(parseGctrlUrl("gctrl://focus/terminal/1/3")).toEqual({
      kind: "focus-terminal",
      windowId: "1",
      tabId: "3",
    })
  })

  it("rejects Apple Terminal path with non-numeric indices", () => {
    expect(parseGctrlUrl("gctrl://focus/terminal/abc/3")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/terminal/1/abc")).toBeNull()
  })

  it("rejects Apple Terminal path with too many components", () => {
    expect(parseGctrlUrl("gctrl://focus/terminal/1/3/extra")).toBeNull()
  })

  it("accepts ghostty / vscode / warp tokens", () => {
    expect(parseGctrlUrl("gctrl://focus/ghostty/sess-abc")).toEqual({
      kind: "focus-generic",
      target: "ghostty",
      token: "sess-abc",
    })
    expect(parseGctrlUrl("gctrl://focus/vscode/v1.workspace")).toEqual({
      kind: "focus-generic",
      target: "vscode",
      token: "v1.workspace",
    })
    expect(parseGctrlUrl("gctrl://focus/warp/abc:123_xyz")).toEqual({
      kind: "focus-generic",
      target: "warp",
      token: "abc:123_xyz",
    })
  })

  it("rejects unknown focus targets", () => {
    expect(parseGctrlUrl("gctrl://focus/kitty/abc")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/xterm/abc")).toBeNull()
  })

  it("rejects generic token with shell metacharacters", () => {
    expect(parseGctrlUrl("gctrl://focus/ghostty/abc;rm")).toBeNull()
    expect(parseGctrlUrl('gctrl://focus/ghostty/abc"def')).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/ghostty/abc def")).toBeNull()
  })
})

describe("parseGctrlUrl — inbox paths", () => {
  it("accepts UUIDv4 message id", () => {
    expect(parseGctrlUrl(`gctrl://inbox/messages/${VALID_UUID}`)).toEqual({
      kind: "inbox-message",
      id: VALID_UUID,
    })
  })

  it("accepts UUIDv4 thread id", () => {
    expect(parseGctrlUrl(`gctrl://inbox/threads/${VALID_UUID}`)).toEqual({
      kind: "inbox-thread",
      id: VALID_UUID,
    })
  })

  it("rejects non-UUIDv4 id (wrong version nibble)", () => {
    // Position 14 is the version; v4 requires `4`. This one uses `5`.
    expect(
      parseGctrlUrl("gctrl://inbox/messages/11111111-2222-5333-8444-555555555555"),
    ).toBeNull()
  })

  it("rejects non-UUIDv4 id (wrong variant nibble)", () => {
    // Position 19 is the variant; must be in [89ab]. This one uses `c`.
    expect(
      parseGctrlUrl("gctrl://inbox/messages/11111111-2222-4333-c444-555555555555"),
    ).toBeNull()
  })

  it("rejects path traversal attempt in id position", () => {
    expect(parseGctrlUrl("gctrl://inbox/messages/../../etc/passwd")).toBeNull()
    expect(parseGctrlUrl("gctrl://inbox/threads/..%2F..%2Fetc")).toBeNull()
  })

  it("rejects unknown inbox sub-resource", () => {
    expect(parseGctrlUrl(`gctrl://inbox/actions/${VALID_UUID}`)).toBeNull()
    expect(parseGctrlUrl(`gctrl://inbox/${VALID_UUID}`)).toBeNull()
  })
})

describe("parseGctrlUrl — global rejections", () => {
  it("rejects empty / non-string input", () => {
    expect(parseGctrlUrl("")).toBeNull()
    expect(parseGctrlUrl(undefined as unknown as string)).toBeNull()
  })

  it("rejects URLs with query strings or fragments", () => {
    expect(parseGctrlUrl(`gctrl://focus/iterm2/${VALID_ITERM2_ID}?evil=1`)).toBeNull()
    expect(parseGctrlUrl(`gctrl://focus/iterm2/${VALID_ITERM2_ID}#frag`)).toBeNull()
  })

  it("rejects embedded NUL / CR / LF", () => {
    expect(parseGctrlUrl("gctrl://focus/iterm2/w0t0p0\x00:abc")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/iterm2/w0t0p0:\nUUID")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/iterm2/w0t0p0:\rUUID")).toBeNull()
  })

  it("rejects schemes other than gctrl:", () => {
    expect(parseGctrlUrl(`http://focus/iterm2/${VALID_ITERM2_ID}`)).toBeNull()
    expect(parseGctrlUrl(`gctrl-evil://focus/iterm2/${VALID_ITERM2_ID}`)).toBeNull()
    // No leading slash variant
    expect(parseGctrlUrl(`gctrl:focus/iterm2/${VALID_ITERM2_ID}`)).toBeNull()
  })

  it("rejects URLs over the length cap", () => {
    const long = "gctrl://focus/iterm2/" + "x".repeat(600)
    expect(parseGctrlUrl(long)).toBeNull()
  })

  it("rejects empty pathname", () => {
    expect(parseGctrlUrl("gctrl://")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/")).toBeNull()
    expect(parseGctrlUrl("gctrl://focus/iterm2/")).toBeNull()
  })
})

describe("focusBodyFor / inboxRouteFor", () => {
  it("focusBodyFor returns null for inbox URLs", () => {
    const parsed = parseGctrlUrl(`gctrl://inbox/messages/${VALID_UUID}`)!
    expect(focusBodyFor(parsed)).toBeNull()
  })

  it("focusBodyFor preserves shape for iTerm2", () => {
    const parsed = parseGctrlUrl(`gctrl://focus/iterm2/${VALID_ITERM2_ID}`)!
    expect(focusBodyFor(parsed)).toEqual({
      target: "iterm2",
      session_id: VALID_ITERM2_ID,
    })
  })

  it("focusBodyFor preserves window/tab for Apple Terminal", () => {
    const parsed = parseGctrlUrl("gctrl://focus/terminal/2/4")!
    expect(focusBodyFor(parsed)).toEqual({
      target: "terminal",
      window_id: "2",
      tab_id: "4",
    })
  })

  it("inboxRouteFor returns null for focus URLs", () => {
    const parsed = parseGctrlUrl(`gctrl://focus/iterm2/${VALID_ITERM2_ID}`)!
    expect(inboxRouteFor(parsed)).toBeNull()
  })

  it("inboxRouteFor preserves the SPA route", () => {
    const m = parseGctrlUrl(`gctrl://inbox/messages/${VALID_UUID}`)!
    expect(inboxRouteFor(m)).toBe(`/inbox/messages/${VALID_UUID}`)
    const t = parseGctrlUrl(`gctrl://inbox/threads/${VALID_UUID}`)!
    expect(inboxRouteFor(t)).toBe(`/inbox/threads/${VALID_UUID}`)
  })
})

describe("handleGctrlUrl", () => {
  function mockDeps(overrides: Partial<UrlHandlerDeps> = {}): UrlHandlerDeps {
    return {
      kernelPost: vi.fn().mockResolvedValue({ ok: true, status: 200, bodyText: "{}" }),
      bringToFront: vi.fn(),
      navigateSpa: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() },
      ...overrides,
    }
  }

  it("dispatches focus URLs to /api/comm/focus", async () => {
    const deps = mockDeps()
    const result = await handleGctrlUrl(
      `gctrl://focus/iterm2/${VALID_ITERM2_ID}`,
      deps,
    )
    expect(deps.kernelPost).toHaveBeenCalledWith("/api/comm/focus", {
      target: "iterm2",
      session_id: VALID_ITERM2_ID,
    })
    expect(result).toMatchObject({ kind: "focus-dispatched", status: 200 })
    expect(deps.bringToFront).not.toHaveBeenCalled()
    expect(deps.navigateSpa).not.toHaveBeenCalled()
  })

  it("routes inbox URLs into the SPA and brings window forward", async () => {
    const deps = mockDeps()
    const result = await handleGctrlUrl(
      `gctrl://inbox/messages/${VALID_UUID}`,
      deps,
    )
    expect(deps.bringToFront).toHaveBeenCalledOnce()
    expect(deps.navigateSpa).toHaveBeenCalledWith(`/inbox/messages/${VALID_UUID}`)
    expect(deps.kernelPost).not.toHaveBeenCalled()
    expect(result).toEqual({
      kind: "inbox-routed",
      route: `/inbox/messages/${VALID_UUID}`,
    })
  })

  it("drops invalid URLs without contacting the kernel or window", async () => {
    const deps = mockDeps()
    const result = await handleGctrlUrl("gctrl://focus/kitty/abc", deps)
    expect(deps.kernelPost).not.toHaveBeenCalled()
    expect(deps.bringToFront).not.toHaveBeenCalled()
    expect(deps.navigateSpa).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: "dropped", reason: "invalid-url" })
  })

  it("surfaces kernel-fetch errors as focus-failed", async () => {
    const deps = mockDeps({
      kernelPost: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    })
    const result = await handleGctrlUrl(
      `gctrl://focus/iterm2/${VALID_ITERM2_ID}`,
      deps,
    )
    expect(result).toEqual({ kind: "focus-failed", reason: "ECONNREFUSED" })
  })

  it("does not navigate the SPA on any focus URL, even one for an inbox-shaped UUID", async () => {
    // Defense-in-depth — the focus handler should never accidentally trip the
    // SPA navigation, even if a URL looks UUID-shaped in the wrong slot.
    const deps = mockDeps()
    const result = await handleGctrlUrl("gctrl://focus/ghostty/abc", deps)
    expect(deps.navigateSpa).not.toHaveBeenCalled()
    expect(deps.bringToFront).not.toHaveBeenCalled()
    expect(result.kind).toBe("focus-dispatched")
  })
})
