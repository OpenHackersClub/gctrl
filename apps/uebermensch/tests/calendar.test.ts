import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import matter from "gray-matter"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemCalendarLive } from "../src/adapters/FileSystemCalendar.js"
import {
  matchesFilter,
  parseDateShortcut,
  sortByStart,
} from "../src/lib/calendar-filter.js"
import {
  CalendarService,
  type CalendarEvent,
} from "../src/services/CalendarService.js"

const seedFile = async (root: string, rel: string, frontmatter: string, body = "") => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  const fm = frontmatter.trim().length === 0 ? "" : `---\n${frontmatter}---\n\n`
  await writeFile(full, `${fm}${body}\n`, "utf8")
}

const baseFrontmatter = (overrides: Record<string, string>) => {
  const fields: Record<string, string> = {
    title: '"sample"',
    kind: "personal",
    source: "user",
    starts_at: "2026-05-01T09:00:00Z",
    tz: "UTC",
    status: "confirmed",
    ...overrides,
  }
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`
}

describe("calendar — pure helpers (parseDateShortcut, matchesFilter, sortByStart)", () => {
  const now = new Date("2026-04-25T12:00:00Z")

  describe("parseDateShortcut", () => {
    it("today resolves to start/end of UTC day", () => {
      expect(parseDateShortcut("today", now, "from")?.toISOString()).toBe(
        "2026-04-25T00:00:00.000Z",
      )
      expect(parseDateShortcut("today", now, "to")?.toISOString()).toBe(
        "2026-04-25T23:59:59.999Z",
      )
    })
    it("tomorrow advances by one UTC day", () => {
      expect(parseDateShortcut("tomorrow", now, "from")?.toISOString()).toBe(
        "2026-04-26T00:00:00.000Z",
      )
    })
    it("+7d advances by seven days", () => {
      expect(parseDateShortcut("+7d", now, "to")?.toISOString()).toBe(
        "2026-05-02T23:59:59.999Z",
      )
    })
    it("+2w advances by two weeks", () => {
      expect(parseDateShortcut("+2w", now, "to")?.toISOString()).toBe(
        "2026-05-09T23:59:59.999Z",
      )
    })
    it("eom resolves to end of current UTC month", () => {
      expect(parseDateShortcut("eom", now, "to")?.toISOString()).toBe(
        "2026-04-30T23:59:59.999Z",
      )
    })
    it("plain YYYY-MM-DD covers the whole day", () => {
      expect(parseDateShortcut("2026-06-15", now, "from")?.toISOString()).toBe(
        "2026-06-15T00:00:00.000Z",
      )
      expect(parseDateShortcut("2026-06-15", now, "to")?.toISOString()).toBe(
        "2026-06-15T23:59:59.999Z",
      )
    })
    it("returns null on garbage", () => {
      expect(parseDateShortcut("not-a-date", now, "from")).toBeNull()
    })
  })

  describe("matchesFilter", () => {
    const e: CalendarEvent = {
      slug: "x",
      title: "NVDA earnings",
      kind: "earnings",
      source: "driver-markets",
      startsAt: "2026-05-21T20:00:00-04:00",
      endsAt: null,
      allDay: false,
      tz: "America/New_York",
      status: "confirmed",
      location: null,
      tickers: ["NVDA"],
      topics: ["ai-infra-capex"],
      theses: ["ai-infra-capex"],
      tags: ["q1-2026"],
      links: [],
      relatedPages: ["nvidia"],
      reminders: [],
      externalId: null,
      externalEtag: null,
      generator: null,
      contentHash: null,
      createdAt: null,
      updatedAt: null,
      matchScore: null,
      matchedTerms: [],
      body: "Quarterly call",
      relPath: "action/events/2026-05-21--nvda.md",
      absPath: "/x",
    }

    it("returns true with no filter", () => {
      expect(matchesFilter(e, undefined)).toBe(true)
      expect(matchesFilter(e, {})).toBe(true)
    })
    it("filters by kind", () => {
      expect(matchesFilter(e, { kind: ["earnings"] })).toBe(true)
      expect(matchesFilter(e, { kind: ["personal"] })).toBe(false)
      expect(matchesFilter(e, { kind: ["earnings", "personal"] })).toBe(true)
    })
    it("filters by source", () => {
      expect(matchesFilter(e, { source: ["driver-markets"] })).toBe(true)
      expect(matchesFilter(e, { source: ["user"] })).toBe(false)
    })
    it("filters by tickers (intersection)", () => {
      expect(matchesFilter(e, { tickers: ["NVDA", "AMZN"] })).toBe(true)
      expect(matchesFilter(e, { tickers: ["AMZN"] })).toBe(false)
    })
    it("filters by topics / theses / tags", () => {
      expect(matchesFilter(e, { topics: ["ai-infra-capex"] })).toBe(true)
      expect(matchesFilter(e, { topics: ["other"] })).toBe(false)
      expect(matchesFilter(e, { theses: ["ai-infra-capex"] })).toBe(true)
      expect(matchesFilter(e, { tags: ["q1-2026"] })).toBe(true)
      expect(matchesFilter(e, { tags: ["q4-2025"] })).toBe(false)
    })
    it("filters by from/to time window", () => {
      // Event is 2026-05-21T20:00 ET → 2026-05-22T00:00 UTC
      expect(matchesFilter(e, { from: "2026-05-21T00:00:00Z" })).toBe(true)
      expect(matchesFilter(e, { from: "2026-05-22T00:00:01Z" })).toBe(false)
      expect(matchesFilter(e, { to: "2026-05-22T23:59:59Z" })).toBe(true)
      expect(matchesFilter(e, { to: "2026-05-21T00:00:00Z" })).toBe(false)
    })
    it("q matches title or body, case-insensitive", () => {
      expect(matchesFilter(e, { q: "NVDA" })).toBe(true)
      expect(matchesFilter(e, { q: "quarterly" })).toBe(true)
      expect(matchesFilter(e, { q: "fomc" })).toBe(false)
    })
    it("predicates AND together", () => {
      expect(matchesFilter(e, { kind: ["earnings"], tickers: ["NVDA"] })).toBe(true)
      expect(matchesFilter(e, { kind: ["earnings"], tickers: ["AMZN"] })).toBe(false)
    })
  })

  describe("sortByStart", () => {
    it("sorts events ascending by startsAt", () => {
      const mk = (slug: string, startsAt: string): CalendarEvent => ({
        ...({} as CalendarEvent),
        slug,
        title: slug,
        kind: "personal",
        source: "user",
        startsAt,
        endsAt: null,
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
        body: "",
        relPath: `action/events/${slug}.md`,
        absPath: `/${slug}`,
      })
      const a = mk("c", "2026-05-03T00:00:00Z")
      const b = mk("a", "2026-05-01T00:00:00Z")
      const c = mk("b", "2026-05-02T00:00:00Z")
      expect(sortByStart([a, b, c]).map((x) => x.slug)).toEqual(["a", "b", "c"])
    })
  })
})

describe("calendar — FileSystemCalendar adapter", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-vault-cal-"))
    await seedFile(
      vaultDir,
      "action/events/2026-05-08--board-meeting.md",
      baseFrontmatter({
        slug: "board-meeting",
        title: '"Board meeting"',
        kind: "personal",
        starts_at: "2026-05-08T14:00:00+08:00",
        tz: "Asia/Hong_Kong",
      }),
      "Quarterly board review with [[projects/quarterly-review]].",
    )
    await seedFile(
      vaultDir,
      "action/events/generated/2026-05-21--nvda-q1-2026-earnings.md",
      baseFrontmatter({
        slug: "nvda-q1-2026-earnings",
        title: '"NVDA Q1 2026 earnings call"',
        kind: "earnings",
        source: "driver-markets",
        starts_at: "2026-05-21T20:00:00-04:00",
        tz: "America/New_York",
        tickers: "[NVDA]",
        topics: "[ai-infra-capex]",
        theses: "[ai-infra-capex]",
        tags: "[earnings, q1-2026]",
      }),
    )
    await seedFile(
      vaultDir,
      "action/events/generated/2026-05-15--us-cpi.md",
      baseFrontmatter({
        slug: "us-cpi-2026-04",
        title: '"US CPI release (Apr 2026)"',
        kind: "macro",
        source: "driver-markets",
        starts_at: "2026-05-15T08:30:00-04:00",
        tz: "America/New_York",
        tags: "[macro, cpi]",
      }),
    )
    // Recurring file — must be skipped by the loader for this slice.
    await seedFile(
      vaultDir,
      "action/events/recurring/weekly-team-standup.md",
      baseFrontmatter({
        slug: "weekly-team-standup",
        title: '"Weekly team standup"',
        kind: "personal",
        starts_at: "2026-04-27T10:00:00Z",
      }),
    )
    // Timebox parent file — different schema (no source/starts_at/tz). The
    // calendar loader MUST skip action/events/timeboxes/ or decodeEvent will
    // throw parse_failure on every list call.
    await seedFile(
      vaultDir,
      "action/events/timeboxes/sub-3-berlin.md",
      [
        "slug: sub-3-berlin",
        "kind: practice",
        "discipline: running",
        'title: "Sub-3 Berlin"',
        'goal: "Run a sub-3 marathon"',
        "deadline: 2026-09-27",
        "unit: km",
        "total: 800",
        "session_minutes: 60",
        'status: "in-progress"',
      ].join("\n") + "\n",
    )
  })

  it("lists all events excluding recurring/ + timeboxes/", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.list({ status: ["confirmed", "tentative", "cancelled"] })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(events.map((e) => e.slug).sort()).toEqual([
      "board-meeting",
      "nvda-q1-2026-earnings",
      "us-cpi-2026-04",
    ])
  })

  it("filters by source (only personal user events)", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.list({ source: ["user"] })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(events.map((e) => e.slug)).toEqual(["board-meeting"])
  })

  it("filters by kind + tickers (earnings on NVDA)", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.list({ kind: ["earnings"], tickers: ["NVDA"] })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(events.map((e) => e.slug)).toEqual(["nvda-q1-2026-earnings"])
  })

  it("filters by date window via from/to", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.list({
          from: "2026-05-14T00:00:00Z",
          to: "2026-05-16T23:59:59Z",
        })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(events.map((e) => e.slug)).toEqual(["us-cpi-2026-04"])
  })

  it("get returns one event by slug", async () => {
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.get("board-meeting")
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(event.title).toBe("Board meeting")
    expect(event.tz).toBe("Asia/Hong_Kong")
    expect(event.body.trim()).toContain("Quarterly board review")
  })

  it("get fails not_found for missing slug", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const cal = yield* CalendarService
          return yield* cal.get("does-not-exist")
        }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
      ),
    )
    expect(result._tag).toBe("Left")
  })

  it("add writes a personal event with derived slug + content_hash", async () => {
    const written = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.add({
          title: "Family dinner",
          kind: "personal",
          startsAt: "2026-05-30T19:30:00+08:00",
          tz: "Asia/Hong_Kong",
        })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(written.slug).toBe("family-dinner")
    expect(written.relPath).toBe("action/events/2026-05-30--family-dinner.md")
    expect(written.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const onDisk = matter(await readFile(written.absPath, "utf8"))
    expect(onDisk.data.source).toBe("user")
    expect(onDisk.data.status).toBe("confirmed")
    expect(onDisk.data.generator).toBe("gctrl-uber-cli")
    expect(onDisk.data.content_hash).toBe(written.contentHash)
    expect(onDisk.data.created_at).toBeTypeOf("string")
  })

  it("add rejects invalid kind via schema", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const cal = yield* CalendarService
          return yield* cal.add({
            title: "Bad event",
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid value
            kind: "not-a-kind" as any,
            startsAt: "2026-06-01T09:00:00Z",
            tz: "UTC",
          })
        }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
      ),
    )
    expect(result._tag).toBe("Left")
  })

  it("add rejects duplicate slug", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const cal = yield* CalendarService
          return yield* cal.add({
            title: "Board meeting again",
            slug: "board-meeting",
            kind: "personal",
            startsAt: "2026-06-01T09:00:00Z",
            tz: "UTC",
          })
        }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
      ),
    )
    expect(result._tag).toBe("Left")
  })

  it("stamp updates frontmatter without touching the body", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        yield* cal.stamp("nvda-q1-2026-earnings", {
          status: "tentative",
          externalEtag: 'W/"new-etag"',
          updatedAt: "2026-04-26T08:00:00Z",
        })
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    const onDisk = matter(
      await readFile(
        join(vaultDir, "action/events/generated/2026-05-21--nvda-q1-2026-earnings.md"),
        "utf8",
      ),
    )
    expect(onDisk.data.status).toBe("tentative")
    expect(onDisk.data.external_etag).toBe('W/"new-etag"')
    expect(onDisk.data.updated_at).toBe("2026-04-26T08:00:00Z")
    // Body untouched (the seeded body is empty, but the title etc. remain)
    expect(onDisk.data.title).toBe("NVDA Q1 2026 earnings call")
  })

  it("returns empty list when action/events/ does not exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "uber-vault-cal-empty-"))
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.list()
      }).pipe(Effect.provide(FileSystemCalendarLive(empty))),
    )
    expect(events).toEqual([])
  })
})
