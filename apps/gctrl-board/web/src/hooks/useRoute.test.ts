import { describe, expect, it } from "vitest"

import { parseRoute } from "./useRoute"

// Each test asserts the exact discriminated-union shape `parseRoute`
// returns. The Schedule routes are new in M1b — adding a fourth
// top-level page to a closed union; the existing pages MUST keep
// parsing the same.

describe("parseRoute — schedule routes (M1b)", () => {
  it("/schedule → schedule page with no name + no runId", () => {
    expect(parseRoute("/schedule")).toEqual({
      page: "schedule",
      name: null,
      runId: null,
    })
    expect(parseRoute("/schedule/")).toEqual({
      page: "schedule",
      name: null,
      runId: null,
    })
  })

  it("/schedule/:name → schedule page with the routine name", () => {
    expect(parseRoute("/schedule/audit.codebase")).toEqual({
      page: "schedule",
      name: "audit.codebase",
      runId: null,
    })
  })

  it("/schedule/:name/runs/:run_id → schedule with name + runId", () => {
    expect(parseRoute("/schedule/audit.codebase/runs/abc-123")).toEqual({
      page: "schedule",
      name: "audit.codebase",
      runId: "abc-123",
    })
  })

  it("regression: /schedule/:name does NOT shadow /analytics/sessions/:id", () => {
    // `parseRoute` matches in priority order; the analytics-sessions
    // pattern is more specific and must still win for analytics paths.
    expect(parseRoute("/analytics/sessions/sess-1")).toEqual({
      page: "analytics",
      tab: "sessions",
      sessionId: "sess-1",
    })
  })

  it("regression: existing routes still parse after the schedule branch", () => {
    expect(parseRoute("/")).toEqual({
      page: "board",
      projectKey: null,
      view: "kanban",
    })
    expect(parseRoute("/inbox")).toEqual({
      page: "inbox",
      threadId: null,
    })
    expect(parseRoute("/analytics")).toEqual({
      page: "analytics",
      tab: "overview",
      sessionId: null,
    })
    expect(parseRoute("/settings/macos-spaces")).toEqual({
      page: "settings",
      section: "macos-spaces",
    })
  })

  it("an unknown path falls back to the board (no false schedule match)", () => {
    expect(parseRoute("/garbage")).toEqual({
      page: "board",
      projectKey: null,
      view: "kanban",
    })
    // Specifically — `/scheduler` (singular ≠ plural) MUST NOT be
    // mistaken for /schedule.
    expect(parseRoute("/scheduler")).toEqual({
      page: "board",
      projectKey: null,
      view: "kanban",
    })
  })
})
