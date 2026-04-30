import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import matter from "gray-matter"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemCalendarLive } from "../src/adapters/FileSystemCalendar.js"
import { LumaSuggesterLive } from "../src/adapters/LumaSuggester.js"
import { CalendarService } from "../src/services/CalendarService.js"
import { EventSuggesterService } from "../src/services/EventSuggesterService.js"
import { ProfileService } from "../src/services/ProfileService.js"

// --- helpers ---

const seedFile = async (root: string, rel: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, body, "utf8")
}

const buildVault = async (city: string | null): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "uber-vault-events-"))
  const cityLine = city ? `\n  city: ${city}` : ""
  await seedFile(
    dir,
    "directives/profile.md",
    `---
schema_version: 1

identity:
  name: "Test"
  slug: "test"
  tz: "Asia/Hong_Kong"
  lang: "en"${cityLine}

budgets:
  daily_usd: 1.00
  per_brief_usd: 0.25

delivery:
  brief:
    cron: "0 30 7 * * *"
    format: "long"
  channels:
    app:
      enabled: true
      driver: "app"
      target_ref: "default"

events:
  enabled: true
  min_match_score: 0.3
  interests:
    - artificial intelligence
    - llms
---
# Profile
`,
  )
  await seedFile(
    dir,
    "directives/topics.md",
    `---
topics:
  - slug: "ai-infra-capex"
    title: "AI infrastructure capex"
    horizon: both
    weight: 1.0
---
`,
  )
  await seedFile(
    dir,
    "directives/sources.md",
    `---
sources:
  - slug: "manual"
    driver: "manual"
    cadence: "manual"
    topics: ["ai-infra-capex"]
---
`,
  )
  return dir
}

const makeLumaHtml = (events: ReadonlyArray<Record<string, unknown>>): string => {
  const list = events.map((e) => ({ "@context": "https://schema.org", "@type": "Event", ...e }))
  return `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@graph": list })}</script>
    </head></html>`
}

const stubFetch =
  (html: string) =>
  async (_url: string) => ({ ok: true, status: 200, text: async () => html })

// --- tests ---

describe("events — pull (LumaSuggester) writes topic-matched suggestions", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await buildVault("hong-kong")
  })

  it("writes suggestions only for events that meet min_match_score", async () => {
    const html = makeLumaHtml([
      {
        name: "AI Infrastructure & LLMs Meetup",
        startDate: "2026-05-12T19:00:00+08:00",
        url: "https://lu.ma/abc",
        description: "Talk on inference",
      },
      {
        name: "Sourdough bread workshop",
        startDate: "2026-05-13T10:00:00+08:00",
        url: "https://lu.ma/bread",
      },
    ])
    const fakeFetch = stubFetch(html)

    const program = Effect.gen(function* () {
      const sug = yield* EventSuggesterService
      return yield* sug.pull({})
    })
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(LumaSuggesterLive({ fetch: fakeFetch })),
        Effect.provide(
          Layer.merge(
            FileSystemCalendarLive(vaultDir),
            (await import("../src/adapters/FileSystemProfile.js")).FileSystemProfileLive(
              vaultDir,
            ),
          ),
        ),
      ),
    )
    expect(result.fetched).toBe(2)
    expect(result.matched).toBe(1)
    expect(result.written).toHaveLength(1)
    expect(result.written[0]?.title).toBe("AI Infrastructure & LLMs Meetup")
    expect(result.written[0]?.matched).toEqual(
      expect.arrayContaining(["ai", "infrastructure", "llms"]),
    )

    const files = await readdir(join(vaultDir, "action/events/suggested"))
    expect(files).toHaveLength(1)
    const text = await readFile(
      join(vaultDir, "action/events/suggested", files[0]!),
      "utf8",
    )
    const fm = matter(text).data as Record<string, unknown>
    expect(fm.source).toBe("driver-events")
    expect(fm.status).toBe("tentative")
    expect(fm.kind).toBe("industry")
    expect(fm.external_id).toBe("luma:abc")
    expect(fm.match_score).toBeGreaterThan(0)
  })

  it("uses --city flag over profile.identity.city", async () => {
    const noCityVault = await buildVault(null)
    const fakeFetch = stubFetch(makeLumaHtml([]))
    const program = Effect.gen(function* () {
      const sug = yield* EventSuggesterService
      return yield* sug.pull({ city: "tokyo" })
    })
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(LumaSuggesterLive({ fetch: fakeFetch })),
        Effect.provide(
          Layer.merge(
            FileSystemCalendarLive(noCityVault),
            (await import("../src/adapters/FileSystemProfile.js")).FileSystemProfileLive(
              noCityVault,
            ),
          ),
        ),
      ),
    )
    expect(result.fetched).toBe(0)
  })

  it("fails clearly when neither flag nor profile city is set", async () => {
    const noCityVault = await buildVault(null)
    const fakeFetch = stubFetch(makeLumaHtml([]))
    const program = Effect.gen(function* () {
      const sug = yield* EventSuggesterService
      return yield* sug.pull({})
    })
    const result = await Effect.runPromise(
      Effect.either(
        program.pipe(
          Effect.provide(LumaSuggesterLive({ fetch: fakeFetch })),
          Effect.provide(
            Layer.merge(
              FileSystemCalendarLive(noCityVault),
              (await import("../src/adapters/FileSystemProfile.js")).FileSystemProfileLive(
                noCityVault,
              ),
            ),
          ),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("re-pulling does not resurrect a dismissed suggestion", async () => {
    const html = makeLumaHtml([
      {
        name: "AI Infra LLMs",
        startDate: "2026-05-20T19:00:00+08:00",
        url: "https://lu.ma/xyz",
      },
    ])
    const fakeFetch = stubFetch(html)
    const profileLayer = (
      await import("../src/adapters/FileSystemProfile.js")
    ).FileSystemProfileLive(vaultDir)

    // First pull creates the suggestion
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const sug = yield* EventSuggesterService
        return yield* sug.pull({})
      }).pipe(
        Effect.provide(LumaSuggesterLive({ fetch: fakeFetch })),
        Effect.provide(Layer.merge(FileSystemCalendarLive(vaultDir), profileLayer)),
      ),
    )
    expect(created.written).toHaveLength(1)
    const slug = created.written[0]!.slug

    // User dismisses it
    await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.dismiss(slug)
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )

    // Second pull skips it (does not flip back to tentative)
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const sug = yield* EventSuggesterService
        return yield* sug.pull({})
      }).pipe(
        Effect.provide(LumaSuggesterLive({ fetch: fakeFetch })),
        Effect.provide(Layer.merge(FileSystemCalendarLive(vaultDir), profileLayer)),
      ),
    )
    expect(second.skippedDismissed).toBe(1)
    expect(second.written).toHaveLength(0)
  })
})

describe("events — accept / dismiss", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await buildVault("hong-kong")
    const html = makeLumaHtml([
      {
        name: "AI Infra LLMs",
        startDate: "2026-05-20T19:00:00+08:00",
        url: "https://lu.ma/xyz",
      },
    ])
    const profileLayer = (
      await import("../src/adapters/FileSystemProfile.js")
    ).FileSystemProfileLive(vaultDir)
    await Effect.runPromise(
      Effect.gen(function* () {
        const sug = yield* EventSuggesterService
        return yield* sug.pull({})
      }).pipe(
        Effect.provide(LumaSuggesterLive({ fetch: stubFetch(html) })),
        Effect.provide(Layer.merge(FileSystemCalendarLive(vaultDir), profileLayer)),
      ),
    )
  })

  it("accept flips status to confirmed and moves out of suggested/", async () => {
    const before = await readdir(join(vaultDir, "action/events/suggested"))
    const slug = before[0]!.match(/--([a-z0-9-]+)\.md$/)![1]!

    const r = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.accept(slug)
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(r.status).toBe("confirmed")
    expect(r.relPath.startsWith("action/events/")).toBe(true)
    expect(r.relPath.includes("/suggested/")).toBe(false)

    const suggestedNow = await readdir(join(vaultDir, "action/events/suggested"))
    expect(suggestedNow).toHaveLength(0)

    const promotedText = await readFile(join(vaultDir, r.relPath), "utf8")
    const fm = matter(promotedText).data as Record<string, unknown>
    expect(fm.status).toBe("confirmed")
    expect(fm.source).toBe("driver-events")
  })

  it("dismiss flips status to cancelled and keeps file in place", async () => {
    const before = await readdir(join(vaultDir, "action/events/suggested"))
    const slug = before[0]!.match(/--([a-z0-9-]+)\.md$/)![1]!

    const r = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.dismiss(slug)
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(r.status).toBe("cancelled")
    expect(r.relPath.startsWith("action/events/suggested/")).toBe(true)

    const text = await readFile(join(vaultDir, r.relPath), "utf8")
    expect((matter(text).data as Record<string, unknown>).status).toBe("cancelled")
  })

  it("accept twice is a no-op the second time", async () => {
    const before = await readdir(join(vaultDir, "action/events/suggested"))
    const slug = before[0]!.match(/--([a-z0-9-]+)\.md$/)![1]!

    await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.accept(slug)
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const cal = yield* CalendarService
        return yield* cal.accept(slug)
      }).pipe(Effect.provide(FileSystemCalendarLive(vaultDir))),
    )
    expect(second.noop).toBe(true)
  })
})
