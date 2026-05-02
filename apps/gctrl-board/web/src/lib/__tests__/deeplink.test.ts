import { describe, expect, it } from "vitest"

import type { CommCapabilities, TerminalContext } from "../../types"
import {
  buildFocusCliCommand,
  buildFocusUrl,
  escapeAttr,
  labelFor,
  shouldShowFocus,
} from "../deeplink"

const VALID_ITERM2_ID = "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765"

const macosCaps: CommCapabilities = {
  os: "macos",
  terminals: ["iterm2", "terminal"],
  notify: false,
  automation_granted: true,
  captured_at: "2026-05-03T00:00:00Z",
}

const linuxCaps: CommCapabilities = {
  os: "linux",
  terminals: [],
  notify: false,
  automation_granted: null,
  captured_at: "2026-05-03T00:00:00Z",
}

const macosCapsAutomationDenied: CommCapabilities = {
  ...macosCaps,
  automation_granted: false,
}

const macosCapsAutomationUnknown: CommCapabilities = {
  ...macosCaps,
  automation_granted: null,
}

describe("buildFocusUrl", () => {
  it("builds the iTerm2 URL for a valid session id", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(buildFocusUrl(t)).toBe(`gctrl://focus/iterm2/${VALID_ITERM2_ID}`)
  })

  it("returns null for iTerm2 with malformed session id", () => {
    const t: TerminalContext = { app: "iterm2", session_id: "not-iterm-shaped" }
    expect(buildFocusUrl(t)).toBeNull()
  })

  it("returns null for iTerm2 with shell-injection attempt", () => {
    const t: TerminalContext = {
      app: "iterm2",
      session_id: 'w0t0p0:X" & do shell script "rm -rf /"',
    }
    expect(buildFocusUrl(t)).toBeNull()
  })

  it("returns null for iTerm2 with no session id at all", () => {
    expect(buildFocusUrl({ app: "iterm2" })).toBeNull()
  })

  it("builds the Apple Terminal URL with window/tab indices", () => {
    const t: TerminalContext = { app: "terminal", window_id: "1", tab_id: "3" }
    expect(buildFocusUrl(t)).toBe("gctrl://focus/terminal/1/3")
  })

  it("returns null for Apple Terminal with non-numeric indices", () => {
    expect(
      buildFocusUrl({ app: "terminal", window_id: "abc", tab_id: "3" }),
    ).toBeNull()
    expect(buildFocusUrl({ app: "terminal", window_id: "1", tab_id: "x" })).toBeNull()
  })

  it("returns null for Apple Terminal missing tab", () => {
    expect(buildFocusUrl({ app: "terminal", window_id: "1" })).toBeNull()
  })

  it("builds the URL for Ghostty / VS Code / Warp with generic session ids", () => {
    expect(buildFocusUrl({ app: "ghostty", session_id: "abc-123" })).toBe(
      "gctrl://focus/ghostty/abc-123",
    )
    expect(buildFocusUrl({ app: "vscode", session_id: "ws.proj_1" })).toBe(
      "gctrl://focus/vscode/ws.proj_1",
    )
    expect(buildFocusUrl({ app: "warp", session_id: "warp:42" })).toBe(
      "gctrl://focus/warp/warp:42",
    )
  })

  it("returns null for generic targets with shell-meta in session id", () => {
    expect(buildFocusUrl({ app: "ghostty", session_id: "abc;rm" })).toBeNull()
    expect(buildFocusUrl({ app: "ghostty", session_id: 'a"b' })).toBeNull()
    expect(buildFocusUrl({ app: "ghostty", session_id: "a b" })).toBeNull()
  })

  it("returns null for unknown app", () => {
    expect(buildFocusUrl({ app: "unknown" })).toBeNull()
  })

  it("returns null for null/undefined input", () => {
    expect(buildFocusUrl(null)).toBeNull()
    expect(buildFocusUrl(undefined)).toBeNull()
  })
})

describe("shouldShowFocus", () => {
  it("renders on macOS with a known terminal and granted automation", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(shouldShowFocus(macosCaps, t)).toBe(true)
  })

  it("renders even when automation_granted is unknown (so the click can trigger the prompt)", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(shouldShowFocus(macosCapsAutomationUnknown, t)).toBe(true)
  })

  it("hides when automation explicitly denied", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(shouldShowFocus(macosCapsAutomationDenied, t)).toBe(false)
  })

  it("hides on non-macOS even with valid context", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(shouldShowFocus(linuxCaps, t)).toBe(false)
  })

  it("hides when caps are still loading (null)", () => {
    const t: TerminalContext = { app: "iterm2", session_id: VALID_ITERM2_ID }
    expect(shouldShowFocus(null, t)).toBe(false)
  })

  it("hides when terminal context is missing", () => {
    expect(shouldShowFocus(macosCaps, undefined)).toBe(false)
  })

  it("hides for unknown app", () => {
    expect(shouldShowFocus(macosCaps, { app: "unknown" })).toBe(false)
  })

  it("hides when caps don't list this terminal (e.g., ghostty not yet supported)", () => {
    const t: TerminalContext = { app: "ghostty", session_id: "abc" }
    expect(shouldShowFocus(macosCaps, t)).toBe(false)
  })
})

describe("labelFor", () => {
  it("returns human labels", () => {
    expect(labelFor("iterm2")).toBe("iTerm2")
    expect(labelFor("terminal")).toBe("Terminal")
    expect(labelFor("ghostty")).toBe("Ghostty")
    expect(labelFor("vscode")).toBe("VS Code")
    expect(labelFor("warp")).toBe("Warp")
    expect(labelFor("unknown")).toBe("unknown")
  })
})

describe("escapeAttr", () => {
  it("escapes the five HTML-attribute-dangerous characters", () => {
    expect(escapeAttr('a"b')).toBe("a&quot;b")
    expect(escapeAttr("a'b")).toBe("a&#39;b")
    expect(escapeAttr("a<b")).toBe("a&lt;b")
    expect(escapeAttr("a>b")).toBe("a&gt;b")
    expect(escapeAttr("a&b")).toBe("a&amp;b")
  })

  it("leaves benign content alone", () => {
    expect(escapeAttr("/Users/v/code")).toBe("/Users/v/code")
  })

  it("escapes & first so previously-escaped sequences don't double-escape weirdly", () => {
    expect(escapeAttr("a&<b")).toBe("a&amp;&lt;b")
  })
})

describe("buildFocusCliCommand", () => {
  it("builds the iTerm2 form", () => {
    expect(
      buildFocusCliCommand({ app: "iterm2", session_id: VALID_ITERM2_ID }),
    ).toBe(`gctrl terminal focus --target iterm2 --session ${VALID_ITERM2_ID}`)
  })

  it("builds the Apple Terminal form", () => {
    expect(
      buildFocusCliCommand({ app: "terminal", window_id: "1", tab_id: "3" }),
    ).toBe("gctrl terminal focus --target terminal --window 1 --tab 3")
  })

  it("returns null when fields are missing", () => {
    expect(buildFocusCliCommand({ app: "iterm2" })).toBeNull()
    expect(buildFocusCliCommand({ app: "terminal", window_id: "1" })).toBeNull()
  })

  it("returns null for unknown", () => {
    expect(buildFocusCliCommand({ app: "unknown" })).toBeNull()
  })
})
