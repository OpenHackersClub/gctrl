import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Schema } from "effect"
import matter from "gray-matter"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemTimeboxLive } from "../src/adapters/FileSystemTimebox.js"
import { plan as runPlanner } from "../src/lib/timebox-planner.js"
import { TimeboxFrontmatter, type TimeboxWorkingWindow } from "../src/schemas.js"
import {
  TimeboxService,
  type TimeboxPlanInput,
} from "../src/services/TimeboxService.js"
import type { CalendarEvent } from "../src/services/CalendarService.js"

const ALL_DAYS_WINDOW: ReadonlyArray<TimeboxWorkingWindow> = [
  { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "07:00", end: "09:00" },
]

const WEEKDAYS_ONLY: ReadonlyArray<TimeboxWorkingWindow> = [
  { days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "08:00" },
]

const stubEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  slug: overrides.slug ?? "x",
  title: "x",
  kind: "personal",
  source: "user",
  startsAt: "2026-05-04T07:00:00Z",
  endsAt: "2026-05-04T08:00:00Z",
  allDay: false,
  tz: "UTC",
  status: "confirmed",
  location: null,
  tickers: [],
  topics: [],
  theses: [],
  tags: [],
  links: [],
  relatedPages: [],
  reminders: [],
  externalId: null,
  externalEtag: null,
  generator: null,
  contentHash: null,
  createdAt: null,
  updatedAt: null,
  matchScore: null,
  matchedTerms: [],
  body: "",
  relPath: "",
  absPath: "",
  ...overrides,
})

describe("timebox schemas", () => {
  it("TimeboxFrontmatter round-trips a valid practice plan", async () => {
    const sample = {
      slug: "sub-3-berlin",
      kind: "practice" as const,
      discipline: "running",
      title: "Sub-3 Berlin",
      goal: "Sub-3 marathon at Berlin",
      deadline: "2026-09-27",
      unit: "km",
      total: 600,
      done: 0,
      session_minutes: 60,
      sessions_per_week: 4,
      status: "active" as const,
      taper_days_before_deadline: 14,
      created_at: "2026-04-29T08:00:00+08:00",
      updated_at: "2026-04-29T08:00:00+08:00",
    }
    const decoded = await Effect.runPromise(Schema.decodeUnknown(TimeboxFrontmatter)(sample))
    expect(decoded.slug).toBe("sub-3-berlin")
    expect(decoded.discipline).toBe("running")
    expect(decoded.total).toBe(600)
  })

  it("rejects invalid status", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Schema.decodeUnknown(TimeboxFrontmatter)({
          slug: "x",
          kind: "practice",
          discipline: "reading",
          title: "x",
          goal: "x",
          deadline: "2026-09-27",
          unit: "pages",
          total: 10,
          session_minutes: 60,
          sessions_per_week: 1,
          status: "wibbly",
        }),
      ),
    )
    Either.match(result, {
      onLeft: () => expect(true).toBe(true),
      onRight: () => {
        throw new Error("expected decode to fail on invalid status")
      },
    })
  })

  it("rejects total <= 0", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Schema.decodeUnknown(TimeboxFrontmatter)({
          slug: "x",
          kind: "practice",
          discipline: "reading",
          title: "x",
          goal: "x",
          deadline: "2026-09-27",
          unit: "pages",
          total: 0,
          session_minutes: 60,
          sessions_per_week: 1,
          status: "active",
        }),
      ),
    )
    Either.match(result, {
      onLeft: () => expect(true).toBe(true),
      onRight: () => {
        throw new Error("expected decode to fail on total=0")
      },
    })
  })
})

describe("timebox planner — pure", () => {
  it("slices remaining work evenly into the right number of sessions", () => {
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 60,
      unit: "pages",
      sessionMinutes: 60,
      sessionsPerWeek: 4,
      deadline: "2026-05-29",
      taperDays: 0,
      today: new Date("2026-05-01T00:00:00Z"),  // Friday
      workingWindows: ALL_DAYS_WINDOW,
      existingEvents: [],
    })
    // 4 weeks remaining (May 1 → May 29), 4/wk → ~16 sessions, 60 pages / 16 ≈ 3.75
    expect(proposal.sessionsNeeded).toBeGreaterThanOrEqual(15)
    expect(proposal.sessionsNeeded).toBeLessThanOrEqual(17)
    expect(proposal.sessions.length).toBeGreaterThan(0)
    // First session is on or after tomorrow
    expect(proposal.sessions[0].date >= "2026-05-02").toBe(true)
  })

  it("respects working_windows — weekday-only excludes Sat/Sun", () => {
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 100,
      unit: "pages",
      sessionMinutes: 60,
      sessionsPerWeek: 5,
      deadline: "2026-05-22",
      taperDays: 0,
      today: new Date("2026-05-01T00:00:00Z"),
      workingWindows: WEEKDAYS_ONLY,
      existingEvents: [],
    })
    for (const s of proposal.sessions) {
      const d = new Date(`${s.date}T00:00:00Z`)
      expect(d.getUTCDay()).not.toBe(0)  // Sun
      expect(d.getUTCDay()).not.toBe(6)  // Sat
    }
  })

  it("honours taper_days_before_deadline — no sessions in the final N days", () => {
    const taper = 7
    const deadline = "2026-06-30"
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 50,
      unit: "km",
      sessionMinutes: 60,
      sessionsPerWeek: 3,
      deadline,
      taperDays: taper,
      today: new Date("2026-05-15T00:00:00Z"),
      workingWindows: ALL_DAYS_WINDOW,
      existingEvents: [],
    })
    const cutoffMs = Date.parse(deadline) - taper * 86_400_000
    for (const s of proposal.sessions) {
      const sMs = Date.parse(`${s.date}T00:00:00Z`)
      expect(sMs).toBeLessThan(cutoffMs)
    }
  })

  it("skips slots that overlap an existing event (double-booking guard)", () => {
    // Existing 07:00-08:00 event on Mon May 4
    const existing = stubEvent({
      slug: "blocker",
      startsAt: "2026-05-04T07:00:00Z",
      endsAt: "2026-05-04T08:00:00Z",
    })
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 30,
      unit: "pages",
      sessionMinutes: 60,
      sessionsPerWeek: 7,
      deadline: "2026-05-15",
      taperDays: 0,
      today: new Date("2026-05-03T00:00:00Z"),
      workingWindows: ALL_DAYS_WINDOW,
      existingEvents: [existing],
    })
    const may4 = proposal.sessions.find((s) => s.date === "2026-05-04")
    expect(may4).toBeUndefined()
    expect(proposal.notes.some((n) => n.includes("2026-05-04") && n.includes("clashes"))).toBe(true)
  })

  it("emits empty proposal + note when nothing remains to plan", () => {
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 0,
      unit: "pages",
      sessionMinutes: 60,
      sessionsPerWeek: 4,
      deadline: "2026-05-29",
      taperDays: 0,
      today: new Date("2026-05-01T00:00:00Z"),
      workingWindows: ALL_DAYS_WINDOW,
      existingEvents: [],
    })
    expect(proposal.sessions).toEqual([])
    expect(proposal.notes[0]).toContain("nothing to plan")
  })

  it("emits warning when deadline (after taper) is in the past", () => {
    const proposal = runPlanner({
      slug: "x",
      remainingUnits: 10,
      unit: "pages",
      sessionMinutes: 60,
      sessionsPerWeek: 4,
      deadline: "2026-04-01",
      taperDays: 0,
      today: new Date("2026-05-01T00:00:00Z"),
      workingWindows: ALL_DAYS_WINDOW,
      existingEvents: [],
    })
    expect(proposal.sessions).toEqual([])
    expect(proposal.notes.some((n) => n.includes("past"))).toBe(true)
  })
})

// === filesystem adapter tests ===

const READ_INPUT = (vaultDir: string): TimeboxPlanInput => ({
  title: "Constitutional AI paper",
  discipline: "reading",
  goal: "Read all 64 pages",
  total: 64,
  unit: "pages",
  sessionMinutes: 60,
  sessionsPerWeek: 4,
  deadline: "2026-05-29",
  tz: "UTC",
  relatedPages: ["paper-constitutional-ai"],
})

const fixedNow = () => new Date("2026-05-01T00:00:00Z")  // Friday

describe("FileSystemTimebox — plan/apply/list/get", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-timebox-"))
    await mkdir(join(vaultDir, "action", "events"), { recursive: true })
  })

  it("plan returns a dry-run proposal without writing", async () => {
    const proposal = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.plan(READ_INPUT(vaultDir))
      }).pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: ALL_DAYS_WINDOW,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 4,
            now: fixedNow,
          }),
        ),
      ),
    )
    expect(proposal.sessions.length).toBeGreaterThan(0)
    // Nothing on disk yet — confirm timeboxes/ wasn't created
    const entries = await readdir(join(vaultDir, "action", "events"), { withFileTypes: true })
    expect(entries.find((e) => e.name === "timeboxes")).toBeUndefined()
  })

  it("apply writes parent + N child events", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(READ_INPUT(vaultDir))
        return yield* svc.apply(READ_INPUT(vaultDir), proposal)
      }).pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: ALL_DAYS_WINDOW,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 4,
            now: fixedNow,
          }),
        ),
      ),
    )
    expect(result.timebox.slug).toBe("constitutional-ai-paper")
    expect(result.childSlugs.length).toBeGreaterThan(0)

    // Parent file exists with valid frontmatter
    const parentRaw = await readFile(
      join(vaultDir, "action/events/timeboxes/constitutional-ai-paper.md"),
      "utf8",
    )
    const parsed = matter(parentRaw)
    expect((parsed.data as { slug: string }).slug).toBe("constitutional-ai-paper")
    expect((parsed.data as { discipline: string }).discipline).toBe("reading")
    expect((parsed.data as { content_hash: string }).content_hash).toMatch(/^sha256:/)

    // Each child file has timebox + step + step_units
    for (const childSlug of result.childSlugs) {
      const raw = await readFile(join(vaultDir, "action", "events", `${childSlug}.md`), "utf8")
      const cm = matter(raw)
      const data = cm.data as { timebox: string; step: number; step_total: number; step_units: string; kind: string }
      expect(data.timebox).toBe("constitutional-ai-paper")
      expect(data.kind).toBe("practice")
      expect(data.step).toBeGreaterThanOrEqual(1)
      expect(data.step_total).toBe(result.childSlugs.length)
      expect(data.step_units).toBeTruthy()
    }
  })

  it("list returns the freshly applied timebox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(READ_INPUT(vaultDir))
        yield* svc.apply(READ_INPUT(vaultDir), proposal)
      }).pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: ALL_DAYS_WINDOW,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 4,
            now: fixedNow,
          }),
        ),
      ),
    )
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.list()
      }).pipe(
        Effect.provide(
          FileSystemTimeboxLive({
            vaultDir,
            tz: "UTC",
            workingWindows: ALL_DAYS_WINDOW,
            defaultSessionMinutes: 60,
            defaultSessionsPerWeek: 4,
            now: fixedNow,
          }),
        ),
      ),
    )
    expect(items).toHaveLength(1)
    expect(items[0].slug).toBe("constitutional-ai-paper")
    expect(items[0].done).toBe(0)
  })

  it("apply twice with the same slug fails with collision", async () => {
    const layer = FileSystemTimeboxLive({
      vaultDir,
      tz: "UTC",
      workingWindows: ALL_DAYS_WINDOW,
      defaultSessionMinutes: 60,
      defaultSessionsPerWeek: 4,
      now: fixedNow,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(READ_INPUT(vaultDir))
        yield* svc.apply(READ_INPUT(vaultDir), proposal)
      }).pipe(Effect.provide(layer)),
    )
    const second = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const svc = yield* TimeboxService
          const proposal = yield* svc.plan(READ_INPUT(vaultDir))
          return yield* svc.apply(READ_INPUT(vaultDir), proposal)
        }).pipe(Effect.provide(layer)),
      ),
    )
    Either.match(second, {
      onLeft: (e) => expect(e.kind).toBe("collision"),
      onRight: () => {
        throw new Error("expected second apply to fail with collision")
      },
    })
  })
})

describe("FileSystemTimebox — complete / skip / setStatus", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-timebox-"))
    await mkdir(join(vaultDir, "action", "events"), { recursive: true })
  })

  const setupLayer = () =>
    FileSystemTimeboxLive({
      vaultDir,
      tz: "UTC",
      workingWindows: ALL_DAYS_WINDOW,
      defaultSessionMinutes: 60,
      defaultSessionsPerWeek: 4,
      now: fixedNow,
    })

  const seed = () =>
    Effect.gen(function* () {
      const svc = yield* TimeboxService
      const proposal = yield* svc.plan(READ_INPUT(vaultDir))
      return yield* svc.apply(READ_INPUT(vaultDir), proposal)
    }).pipe(Effect.provide(setupLayer()))

  it("complete rolls done up using parsed step_units (pages range)", async () => {
    const applied = await Effect.runPromise(seed())
    expect(applied.timebox.done).toBe(0)

    // Find step 1's step_units to know what we expect to credit
    const firstChildRaw = await readFile(
      join(vaultDir, "action", "events", `${applied.childSlugs[0]}.md`),
      "utf8",
    )
    const firstChildData = matter(firstChildRaw).data as { step_units: string }
    // Planner format: "pages 1-4" for multi-page sessions, "page 1" for sub-1 sessions.
    // 64 pages / ~16 sessions = 4 pages/session, so we expect a range form.
    expect(firstChildData.step_units).toMatch(/pages? \d/)

    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.complete(applied.timebox.slug, 1)
      }).pipe(Effect.provide(setupLayer())),
    )
    expect(after.done).toBeGreaterThan(0)
    expect(after.done).toBeLessThanOrEqual(applied.timebox.total)
  })

  it("complete twice on same step is idempotent (no double credit)", async () => {
    const applied = await Effect.runPromise(seed())
    const layer = setupLayer()

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.complete(applied.timebox.slug, 1)
      }).pipe(Effect.provide(layer)),
    )
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.complete(applied.timebox.slug, 1)
      }).pipe(Effect.provide(layer)),
    )
    expect(second.done).toBe(first.done)
  })

  it("skip marks the child cancelled and does NOT credit done", async () => {
    const applied = await Effect.runPromise(seed())
    const layer = setupLayer()

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.skip(applied.timebox.slug, 1)
      }).pipe(Effect.provide(layer)),
    )

    // Re-read the parent — done should still be 0
    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.get(applied.timebox.slug)
      }).pipe(Effect.provide(layer)),
    )
    expect(reloaded.done).toBe(0)

    // First child file must be marked cancelled
    const childRaw = await readFile(
      join(vaultDir, "action", "events", `${applied.childSlugs[0]}.md`),
      "utf8",
    )
    expect((matter(childRaw).data as { status: string }).status).toBe("cancelled")
  })

  it("setStatus pause then resume round-trips status", async () => {
    const applied = await Effect.runPromise(seed())
    const layer = setupLayer()

    const paused = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.setStatus(applied.timebox.slug, "paused")
      }).pipe(Effect.provide(layer)),
    )
    expect(paused.status).toBe("paused")

    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.setStatus(applied.timebox.slug, "active")
      }).pipe(Effect.provide(layer)),
    )
    expect(resumed.status).toBe("active")
  })

  it("get fails not_found for missing slug", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const svc = yield* TimeboxService
          return yield* svc.get("does-not-exist")
        }).pipe(Effect.provide(setupLayer())),
      ),
    )
    Either.match(result, {
      onLeft: (e) => expect(e.kind).toBe("not_found"),
      onRight: () => {
        throw new Error("expected get to fail with not_found")
      },
    })
  })
})

describe("FileSystemTimebox — replan", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-timebox-"))
    await mkdir(join(vaultDir, "action", "events"), { recursive: true })
  })

  it("replan supersedes pending children and writes a new schedule", async () => {
    const layer = FileSystemTimeboxLive({
      vaultDir,
      tz: "UTC",
      workingWindows: ALL_DAYS_WINDOW,
      defaultSessionMinutes: 60,
      defaultSessionsPerWeek: 4,
      now: fixedNow,
    })

    const applied = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(READ_INPUT(vaultDir))
        return yield* svc.apply(READ_INPUT(vaultDir), proposal)
      }).pipe(Effect.provide(layer)),
    )
    const originalChildCount = applied.childSlugs.length

    // Re-plan
    const replanResult = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.replan(applied.timebox.slug)
        return yield* svc.applyReplan(applied.timebox.slug, proposal)
      }).pipe(Effect.provide(layer)),
    )

    // The original children should be marked superseded
    expect(replanResult.supersededSlugs.length).toBe(originalChildCount)
    expect(replanResult.childSlugs.length).toBeGreaterThan(0)

    // Spot-check: first original child file's status is now superseded
    const supersededRaw = await readFile(
      join(vaultDir, "action", "events", `${applied.childSlugs[0]}.md`),
      "utf8",
    )
    expect((matter(supersededRaw).data as { status: string }).status).toBe("superseded")
  })
})

describe("FileSystemTimebox — addEvent", () => {
  it("appends a child event and increments step_total of new entries", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "uber-timebox-"))
    await mkdir(join(vaultDir, "action", "events"), { recursive: true })
    const layer = FileSystemTimeboxLive({
      vaultDir,
      tz: "UTC",
      workingWindows: ALL_DAYS_WINDOW,
      defaultSessionMinutes: 60,
      defaultSessionsPerWeek: 4,
      now: fixedNow,
    })

    const applied = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        const proposal = yield* svc.plan(READ_INPUT(vaultDir))
        return yield* svc.apply(READ_INPUT(vaultDir), proposal)
      }).pipe(Effect.provide(layer)),
    )
    const originalCount = applied.childSlugs.length

    const added = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TimeboxService
        return yield* svc.addEvent({
          timeboxSlug: applied.timebox.slug,
          startsAt: "2026-05-30T07:00:00Z",
          tz: "UTC",
          units: "pages 11-12",
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(added.step).toBe(originalCount + 1)
    expect(added.stepTotal).toBe(originalCount + 1)
  })
})
