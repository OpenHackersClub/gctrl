import { describe, expect, it } from "vitest"
import type { AgentRun, InboxMessage } from "../../types"
import {
  buildLanes,
  cardGoal,
  cardHeadline,
  cardProgress,
  columnFor,
  formatUsage,
  gatherErrorMessage,
  gatherPreview,
  gatherResultMessage,
  laneSummary,
  needsYouSessionIds,
  openErrorMessage,
  openResultMessage,
  relativeTime,
} from "../agent-lanes"

const NOW = new Date("2026-11-28T12:00:00Z")

const run = (overrides: Partial<AgentRun> & { id: string }): AgentRun => ({
  harness: "claude-code",
  native_id: overrides.id.replace(/^[a-z]+:/, ""),
  title: `Run ${overrides.id}`,
  name: null,
  project_key: "gctrl",
  cwd: "/repo/gctrl",
  cwd_exists: true,
  worktree: null,
  git_branch: "main",
  last_prompt: null,
  pr: null,
  cost_usd: null,
  tokens: null,
  model: null,
  started_at: "2026-11-28T10:00:00Z",
  updated_at: "2026-11-28T11:00:00Z",
  headless: false,
  archived: false,
  stale: false,
  live: null,
  state: "resumable",
  resume_command: "cd '/repo/gctrl' && claude --resume x",
  ...overrides,
})

const message = (overrides: Partial<InboxMessage> & { id: string }): InboxMessage => ({
  thread_id: "t1",
  source: "agent",
  kind: "permission_request",
  urgency: "high",
  title: "Allow Bash?",
  context: {},
  status: "pending",
  requires_action: true,
  duplicate_count: 0,
  created_at: "2026-11-28T11:59:00Z",
  updated_at: "2026-11-28T11:59:00Z",
  ...overrides,
})

describe("needsYouSessionIds", () => {
  it("collects session ids of pending, actionable, unexpired messages", () => {
    const ids = needsYouSessionIds(
      [
        message({ id: "m1", context: { session_id: "aaa" } }),
        message({ id: "m2", context: { session_id: "bbb" }, status: "resolved" }),
        message({ id: "m3", context: { session_id: "ccc" }, requires_action: false }),
        message({
          id: "m4",
          context: { session_id: "ddd" },
          expires_at: "2026-11-28T11:00:00Z",
        }),
        message({
          id: "m5",
          context: { session_id: "eee" },
          expires_at: "2026-11-28T13:00:00Z",
        }),
        message({ id: "m6", context: {} }),
        message({ id: "m7", context: { session_id: 42 } }),
      ],
      NOW,
    )
    expect([...ids].sort()).toEqual(["aaa", "eee"])
  })
})

describe("columnFor", () => {
  const needs = new Set(["live-q", "dead-q"])

  it("maps kernel state to its column", () => {
    expect(columnFor(run({ id: "claude:a", state: "running" }), needs)).toBe("running")
    expect(columnFor(run({ id: "claude:b", state: "idle" }), needs)).toBe("idle")
    expect(columnFor(run({ id: "claude:c", state: "resumable" }), needs)).toBe("resumable")
    expect(columnFor(run({ id: "claude:d", state: "done" }), needs)).toBe("done")
  })

  it("puts a live run with an open request in Needs you", () => {
    const r = run({ id: "claude:live-q", state: "idle", live: { pid: 1, tty: null, status: "idle" } })
    expect(columnFor(r, needs)).toBe("needs_you")
  })

  it("keeps a dead or done run out of Needs you", () => {
    expect(columnFor(run({ id: "claude:dead-q", state: "resumable" }), needs)).toBe("resumable")
    expect(columnFor(run({ id: "claude:live-q", state: "done" }), needs)).toBe("done")
  })
})

describe("buildLanes", () => {
  it("groups by project, sorts lanes by most urgent column then recency", () => {
    const runs = [
      run({ id: "claude:old", project_key: "alpha", state: "resumable", updated_at: "2026-11-28T09:00:00Z" }),
      run({
        id: "claude:busy",
        project_key: "beta",
        state: "running",
        live: { pid: 2, tty: "/dev/ttys001", status: "busy" },
        updated_at: "2026-11-28T08:00:00Z",
      }),
      run({ id: "codex:fresh", harness: "codex", project_key: "gamma", state: "resumable", updated_at: "2026-11-28T11:30:00Z" }),
      run({
        id: "claude:ask",
        project_key: "delta",
        state: "idle",
        live: { pid: 3, tty: null, status: "idle" },
        updated_at: "2026-11-27T08:00:00Z",
      }),
    ]
    const lanes = buildLanes(runs, new Set(["ask"]))
    expect(lanes.map((l) => l.projectKey)).toEqual(["delta", "beta", "gamma", "alpha"])
    expect(lanes[0].columns.needs_you.map((r) => r.id)).toEqual(["claude:ask"])
  })

  it("sorts cards in a column newest first and marks live lanes", () => {
    const lanes = buildLanes(
      [
        run({ id: "claude:a", updated_at: "2026-11-28T09:00:00Z" }),
        run({ id: "claude:b", updated_at: "2026-11-28T11:00:00Z" }),
        run({
          id: "claude:c",
          state: "idle",
          live: { pid: 4, tty: null, status: "idle" },
          project_key: "other",
        }),
      ],
      new Set(),
    )
    const gctrl = lanes.find((l) => l.projectKey === "gctrl")
    const other = lanes.find((l) => l.projectKey === "other")
    expect(gctrl?.columns.resumable.map((r) => r.id)).toEqual(["claude:b", "claude:a"])
    expect(gctrl?.live).toBe(false)
    expect(other?.live).toBe(true)
    expect(gctrl?.counts).toEqual({ needs_you: 0, running: 0, idle: 0, resumable: 2, done: 0 })
  })
})

describe("laneSummary", () => {
  it("lists non-empty columns and the last activity", () => {
    const [lane] = buildLanes(
      [
        run({ id: "claude:a", updated_at: "2026-11-26T12:00:00Z" }),
        run({ id: "codex:b", harness: "codex", state: "done", updated_at: "2026-11-25T12:00:00Z" }),
      ],
      new Set(),
    )
    expect(laneSummary(lane, NOW)).toBe("1 resumable · 1 done · last active 2d ago")
  })
})

describe("relativeTime", () => {
  it("buckets by minute, hour and day", () => {
    expect(relativeTime("2026-11-28T11:59:40Z", NOW)).toBe("just now")
    expect(relativeTime("2026-11-28T11:55:00Z", NOW)).toBe("5m ago")
    expect(relativeTime("2026-11-28T09:00:00Z", NOW)).toBe("3h ago")
    expect(relativeTime("2026-11-20T12:00:00Z", NOW)).toBe("8d ago")
  })
})

describe("cardHeadline", () => {
  it("prefers the name, falls back to the title", () => {
    expect(cardHeadline(run({ id: "claude:a", name: "s-agent-panel", title: "agent panel" }))).toBe(
      "s-agent-panel",
    )
    expect(cardHeadline(run({ id: "claude:b", name: null, title: "Fix the build" }))).toBe("Fix the build")
  })
})

describe("formatUsage", () => {
  it("shows cost for Claude and tokens for Codex", () => {
    expect(formatUsage(run({ id: "claude:a", cost_usd: 3.104 }))).toBe("$3.10")
    expect(formatUsage(run({ id: "codex:b", harness: "codex", tokens: 12_345 }))).toBe("12.3k tok")
    expect(formatUsage(run({ id: "codex:c", harness: "codex", tokens: 2_500_000 }))).toBe("2.5M tok")
    expect(formatUsage(run({ id: "claude:d" }))).toBeNull()
  })
})

describe("openResultMessage", () => {
  it("describes each open action", () => {
    expect(openResultMessage({ action: "focused", detail: "iTerm2" })).toEqual({
      message: "Focused iTerm2",
      type: "success",
    })
    expect(openResultMessage({ action: "launched", command: "cd x && claude --resume y" })).toEqual({
      message: "Resumed in a new iTerm2 tab",
      type: "success",
    })
    expect(openResultMessage({ action: "none", detail: "terminal_not_found" })).toEqual({
      message: "Live, but its terminal pane was not found",
      type: "error",
    })
    expect(openResultMessage({ action: "would_launched", command: "cd x && claude --resume y" })).toEqual({
      message: "Dry run: would launch `cd x && claude --resume y`",
      type: "success",
    })
  })
})

describe("openErrorMessage", () => {
  it("maps kernel status codes to operator copy", () => {
    expect(openErrorMessage(new Error("409: cwd_missing"))).toBe("Worktree removed — cannot resume here")
    expect(openErrorMessage(new Error("403: automation denied"))).toBe(
      "Automation denied — allow gctrl to control iTerm2 in System Settings",
    )
    expect(openErrorMessage(new Error("404: unknown run"))).toBe("Run no longer exists")
    expect(openErrorMessage(new Error("502: boom"))).toBe("Open failed: 502: boom")
  })
})

describe("gather", () => {
  const live = (status: "busy" | "idle" | "unknown", tty: string | null = "/dev/ttys001") => ({
    pid: 1,
    tty,
    status,
  })

  it("previews how each selected run moves", () => {
    const p = gatherPreview([
      run({ id: "claude:a" }),
      run({ id: "codex:b", live: live("idle") }),
      run({ id: "hermes:c", live: live("busy") }),
      run({ id: "pi:d", live: live("unknown") }),
      run({ id: "claude:e", cwd_exists: false }),
      run({ id: "claude:f", live: live("idle", null) }),
    ])
    expect(p).toEqual({ resume: 1, move: 1, wait: 2, skip: 2 })
  })

  it("summarizes a gather result", () => {
    const t = gatherResultMessage({
      window_id: 7,
      items: [
        { id: "a", action: "resumed" },
        { id: "b", action: "moved" },
        { id: "c", action: "queued" },
        { id: "d", action: "skipped", detail: "cwd_missing" },
      ],
    })
    expect(t.type).toBe("success")
    expect(t.message).toBe("Gathered: 2 in one iTerm2 window · 1 waiting for its turn to end · 1 skipped (cwd_missing)")
    const none = gatherResultMessage({ window_id: null, items: [{ id: "a", action: "skipped", detail: "unknown_run" }] })
    expect(none.type).toBe("error")
  })

  it("explains switch and gather failures", () => {
    expect(gatherErrorMessage(new Error("403: denied"), "switch")).toContain("Accessibility")
    expect(gatherErrorMessage(new Error("501: off"), "switch")).toContain("Mission Control")
    expect(gatherErrorMessage(new Error("403: x"), "gather")).toContain("Automation denied")
  })
})

describe("goal and progress", () => {
  const progress = (o: Partial<NonNullable<AgentRun["progress"]>> = {}) => ({
    status: "active",
    summary: null,
    current_step: null,
    steps_done: 0,
    steps_total: 0,
    ...o,
  })

  it("leads with the goal, never repeating the headline", () => {
    expect(cardGoal(run({ id: "claude:a", name: "s-x", goal: "Ship the parser" }))).toBe("Ship the parser")
    expect(cardGoal(run({ id: "codex:b", name: "Fix login", goal: "Fix login" }))).toBeNull()
    expect(cardGoal(run({ id: "claude:c", name: "s-y", title: "Refactor auth" }))).toBe("Refactor auth")
    expect(cardGoal(run({ id: "claude:d", title: "Only title" }))).toBeNull()
  })

  it("shows the current step, else the summary, with the step count", () => {
    const step = run({ id: "claude:a", progress: progress({ current_step: "review", steps_done: 2, steps_total: 4 }) })
    expect(cardProgress(step)).toBe("review · 2/4")
    const summary = run({ id: "claude:b", progress: progress({ summary: "tests green" }) })
    expect(cardProgress(summary)).toBe("tests green")
    expect(cardProgress(run({ id: "claude:c" }))).toBeNull()
  })

  it("moves a live blocked or handoff run to Needs you", () => {
    const live = { pid: 1, tty: "/dev/ttys001", status: "idle" as const }
    const blocked = run({ id: "claude:a", state: "idle", live, progress: progress({ status: "blocked" }) })
    expect(columnFor(blocked, new Set())).toBe("needs_you")
    const ended = run({ id: "claude:b", state: "resumable", progress: progress({ status: "handoff" }) })
    expect(columnFor(ended, new Set())).toBe("resumable")
    const active = run({ id: "claude:c", state: "idle", live, progress: progress() })
    expect(columnFor(active, new Set())).toBe("idle")
  })
})
