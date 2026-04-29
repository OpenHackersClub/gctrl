import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { FileSystemProfileLive } from "../src/adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { HttpFeedConfigTag, HttpFeedLive } from "../src/adapters/HttpFeed.js"
import { HttpIngestConfigTag, HttpIngestLive } from "../src/adapters/HttpIngest.js"
import { parseFeed } from "../src/lib/rss.js"
import { FeedService } from "../src/services/FeedService.js"
import { IngestService } from "../src/services/IngestService.js"

const rss2Fixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <link>https://news.example.com/</link>
  <description>Sample</description>
  <item>
    <title><![CDATA[BoJ holds rates at 0.75%]]></title>
    <link>https://news.example.com/2026/04/22/boj-holds</link>
    <guid isPermaLink="true">https://news.example.com/2026/04/22/boj-holds</guid>
    <pubDate>Wed, 22 Apr 2026 07:00:00 GMT</pubDate>
    <description>The Bank of Japan held its policy rate.</description>
  </item>
  <item>
    <title>Senate recruiting heats up in Michigan</title>
    <link>https://news.example.com/2026/04/21/mi-senate</link>
    <pubDate>Tue, 21 Apr 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Ancient news</title>
    <link>https://news.example.com/2024/01/01/ancient</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`

const atomFixture = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>MHLW releases LTCI premium update</title>
    <link rel="alternate" href="https://mhlw.example.jp/press/1" />
    <id>tag:mhlw.example.jp,2026:press/1</id>
    <updated>2026-04-22T08:00:00Z</updated>
    <summary>Ministry updates long-term care insurance premiums.</summary>
  </entry>
  <entry>
    <title>Another entry</title>
    <link rel="alternate" href="https://mhlw.example.jp/press/2" />
    <updated>2026-04-19T00:00:00Z</updated>
  </entry>
</feed>`

describe("parseFeed", () => {
  it("parses RSS 2.0 with CDATA titles and dated items", () => {
    const parsed = parseFeed(rss2Fixture)
    expect(parsed.format).toBe("rss2")
    expect(parsed.title).toBe("Test Feed")
    expect(parsed.items).toHaveLength(3)
    expect(parsed.items[0].title).toBe("BoJ holds rates at 0.75%")
    expect(parsed.items[0].link).toBe("https://news.example.com/2026/04/22/boj-holds")
    expect(parsed.items[0].publishedAt?.toISOString()).toBe("2026-04-22T07:00:00.000Z")
    expect(parsed.items[2].publishedAt?.getUTCFullYear()).toBe(2024)
  })
  it("parses Atom with rel=alternate links", () => {
    const parsed = parseFeed(atomFixture)
    expect(parsed.format).toBe("atom")
    expect(parsed.title).toBe("Atom Feed")
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].link).toBe("https://mhlw.example.jp/press/1")
    expect(parsed.items[0].publishedAt?.toISOString()).toBe("2026-04-22T08:00:00.000Z")
  })
  it("returns unknown format for garbage", () => {
    expect(parseFeed("not xml").format).toBe("unknown")
  })
})

type MockFetchMap = Record<string, { body: string; status?: number; headers?: Record<string, string> }>

const makeFetch = (map: MockFetchMap): typeof fetch =>
  (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    const hit = map[url]
    if (!hit) return new Response("not found", { status: 404 })
    return new Response(hit.body, {
      status: hit.status ?? 200,
      headers: hit.headers ?? { "content-type": "application/xml" },
    })
  }) as unknown as typeof fetch

const htmlFor = (title: string, body: string) => `
<!doctype html><html><head><title>${title}</title></head>
<body><article><h1>${title}</h1>${body
  .split("\n")
  .map((p) => `<p>${p}</p>`)
  .join("")}</article></body></html>`

const mkVault = async () => {
  const dir = await mkdtemp(join(tmpdir(), "uber-rss-"))
  await mkdir(join(dir, "wiki"), { recursive: true })
  await mkdir(join(dir, "directives", "theses"), { recursive: true })
  await mkdir(join(dir, "input", "raw"), { recursive: true })
  await writeFile(
    join(dir, "directives", "profile.md"),
    `---
schema_version: 1
identity: { name: "T", slug: "t", tz: "UTC", lang: "en" }
budgets: { daily_usd: 1, per_brief_usd: 0.5 }
delivery:
  brief: { cron: "0 0 * * *", format: "short" }
  channels: {}
---
`,
    "utf8",
  )
  await writeFile(
    join(dir, "directives", "topics.md"),
    `---
topics:
  - slug: japan-macro
    title: Japan macro
    horizon: both
    weight: 1.0
  - slug: us-midterms-2026
    title: US midterms
    horizon: both
    weight: 1.0
---
`,
    "utf8",
  )
  await writeFile(
    join(dir, "directives", "sources.md"),
    `---
sources:
  - slug: test-rss
    driver: rss
    url: https://feeds.example.com/combined.xml
    cadence: "0 */30 * * * *"
    topics: [japan-macro, us-midterms-2026]
  - slug: manual-only
    driver: manual
    cadence: "@never"
    topics: [japan-macro]
---
`,
    "utf8",
  )
  return dir
}

// Thin helper to count ingested files under input/raw/
const countSources = async (dir: string): Promise<number> => {
  try {
    const entries = await readdir(join(dir, "input", "raw"))
    return entries.filter((e) => e.endsWith(".md")).length
  } catch {
    return 0
  }
}

describe("feed → ingest acceptance", () => {
  it("fetches a feed, filters by window, forces topics, and writes pages", async () => {
    const dir = await mkVault()
    const cutoff = new Date("2026-04-20T00:00:00Z") // items before this get filtered
    const mockFetch = makeFetch({
      "https://feeds.example.com/combined.xml": { body: rss2Fixture },
      "https://news.example.com/2026/04/22/boj-holds": {
        body: htmlFor("BoJ holds rates", "BoJ held the policy rate steady.\nYen reacted modestly."),
      },
      "https://news.example.com/2026/04/21/mi-senate": {
        body: htmlFor("Senate MI", "Michigan Senate race competitive.\nGOP recruit announced."),
      },
      "https://news.example.com/2024/01/01/ancient": {
        body: htmlFor("Old", "ancient content.\npadding for word count."),
      },
    })

    const program = Effect.gen(function* () {
      const feedSvc = yield* FeedService
      const ingestSvc = yield* IngestService
      const feed = yield* feedSvc.fetchFeed("https://feeds.example.com/combined.xml")
      expect(feed.items).toHaveLength(3)
      const recent = feed.items.filter(
        (it) => it.publishedAt && it.publishedAt >= cutoff,
      )
      expect(recent).toHaveLength(2)
      const out: Array<string> = []
      for (const item of recent) {
        const r = yield* ingestSvc.ingestUrl({
          url: item.link,
          date: "2026-04-22",
          topicSlugs: ["japan-macro", "us-midterms-2026"],
          minWordCount: 5,
          overwrite: false,
          forceTopics: ["japan-macro", "us-midterms-2026"],
        })
        out.push(r.slug)
      }
      return out
    })
    const layer = Layer.mergeAll(
      FileSystemProfileLive(dir),
      FileSystemVaultLive(dir),
      HttpFeedLive.pipe(
        Layer.provide(Layer.succeed(HttpFeedConfigTag, { fetch: mockFetch })),
      ),
      HttpIngestLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystemVaultLive(dir),
            Layer.succeed(HttpIngestConfigTag, { fetch: mockFetch }),
          ),
        ),
      ),
    )
    const slugs = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(slugs).toHaveLength(2)
    expect(slugs.every((s) => s.startsWith("2026-04-22--news-example-com--"))).toBe(true)
    expect(await countSources(dir)).toBe(2)
  })

  it("second pass over the same feed results in zero new pages (dedup on collision)", async () => {
    const dir = await mkVault()
    const mockFetch = makeFetch({
      "https://feeds.example.com/combined.xml": { body: rss2Fixture },
      "https://news.example.com/2026/04/22/boj-holds": {
        body: htmlFor("BoJ holds rates", "BoJ held the policy rate steady.\npadding padding padding."),
      },
      "https://news.example.com/2026/04/21/mi-senate": {
        body: htmlFor("Senate MI", "Michigan Senate race competitive.\npadding padding padding."),
      },
    })
    const runOnce = Effect.gen(function* () {
      const feedSvc = yield* FeedService
      const ingestSvc = yield* IngestService
      const feed = yield* feedSvc.fetchFeed("https://feeds.example.com/combined.xml")
      const results: Array<string> = []
      for (const item of feed.items) {
        if (!item.link) continue
        const r = yield* ingestSvc
          .ingestUrl({
            url: item.link,
            date: "2026-04-22",
            topicSlugs: ["japan-macro", "us-midterms-2026"],
            minWordCount: 3,
            overwrite: false,
            forceTopics: ["japan-macro"],
          })
          .pipe(
            Effect.map((r) => ({ kind: "ok" as const, slug: r.slug })),
            Effect.catchTag("IngestError", (e) =>
              Effect.succeed({ kind: e.kind, slug: null as string | null }),
            ),
          )
        results.push(r.kind)
      }
      return results
    })
    const layer = Layer.mergeAll(
      FileSystemProfileLive(dir),
      FileSystemVaultLive(dir),
      HttpFeedLive.pipe(
        Layer.provide(Layer.succeed(HttpFeedConfigTag, { fetch: mockFetch })),
      ),
      HttpIngestLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystemVaultLive(dir),
            Layer.succeed(HttpIngestConfigTag, { fetch: mockFetch }),
          ),
        ),
      ),
    )

    const first = await Effect.runPromise(runOnce.pipe(Effect.provide(layer)))
    const firstOk = first.filter((k) => k === "ok").length
    expect(firstOk).toBeGreaterThanOrEqual(2) // two recent + maybe ancient (no window here)
    const countAfterFirst = await countSources(dir)

    const second = await Effect.runPromise(runOnce.pipe(Effect.provide(layer)))
    const secondOk = second.filter((k) => k === "ok").length
    const secondCollisions = second.filter((k) => k === "collision").length
    expect(secondOk).toBe(0)
    expect(secondCollisions).toBeGreaterThanOrEqual(2)
    expect(await countSources(dir)).toBe(countAfterFirst)
  })

  it("feed fetch failure surfaces an IngestError and does not blow up", async () => {
    const dir = await mkVault()
    const mockFetch = makeFetch({}) // all URLs 404
    const program = Effect.gen(function* () {
      const feedSvc = yield* FeedService
      return yield* feedSvc.fetchFeed("https://feeds.example.com/combined.xml").pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("IngestError", (e) => Effect.succeed(e.kind)),
      )
    })
    const layer = HttpFeedLive.pipe(
      Layer.provide(Layer.succeed(HttpFeedConfigTag, { fetch: mockFetch })),
    )
    const out = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(out).toBe("fetch_failed")
  })
})

// Silence unused-import warning in isolatedModules mode.
void Context
