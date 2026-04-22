import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
import matter from "gray-matter"
import { describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import {
  classifyTopics,
  detectPaywall,
  HttpIngestConfigTag,
  HttpIngestLive,
} from "../src/adapters/HttpIngest.js"
import { IngestService } from "../src/services/IngestService.js"

const mkFetch = (body: string, status = 200): typeof fetch =>
  (async () =>
    new Response(body, { status, headers: { "content-type": "text/html" } })) as unknown as typeof fetch

describe("detectPaywall", () => {
  it("flags FT-style teaser boilerplate", () => {
    const body = `Prudential extends Japan pause.

Subscribe to unlock this article

Try unlimited access
Only S$1 for 4 weeks`
    const r = detectPaywall(body)
    expect(r.paywalled).toBe(true)
  })
  it("flags Bloomberg-style sign-in wall", () => {
    const body = "Lede paragraph...\n\nSign in to read the rest."
    expect(detectPaywall(body).paywalled).toBe(true)
  })
  it("does not flag clean article body", () => {
    const body =
      "The Bank of Japan raised its policy rate to 0.75% today, Governor Ueda announced. Markets reacted with a sharp move in the yen."
    expect(detectPaywall(body).paywalled).toBe(false)
  })
})

describe("classifyTopics with watchlist expansion", () => {
  const watchlists = {
    "japan-macro": ["boj", "ueda", "yen", "usd-jpy", "jgb"],
    "japan-aging-healthcare": ["mhlw", "pmda", "dementia-care"],
    "us-midterms-2026": ["midterms-2026", "nrcc", "dccc", "redistricting"],
  }
  const topicSlugs = Object.keys(watchlists)

  it("matches japan-macro via watchlist term 'boj'", () => {
    const hits = classifyTopics("The BoJ held rates steady.", topicSlugs, watchlists)
    expect(hits).toContain("japan-macro")
    expect(hits).not.toContain("japan-aging-healthcare")
  })
  it("matches multi-word watchlist terms like 'usd-jpy'", () => {
    const hits = classifyTopics("USD/JPY touched 155 overnight.", topicSlugs, watchlists)
    expect(hits).toContain("japan-macro")
  })
  it("uses word-boundary — 'us' inside 'usual' does not match", () => {
    const wl = { "us-politics": ["us"] }
    const hits = classifyTopics("Usual market volatility persists.", ["us-politics"], wl)
    expect(hits).not.toContain("us-politics")
  })
  it("falls back to slug-as-phrase when no watchlist", () => {
    const hits = classifyTopics("A semiconductors story", ["semiconductors"], {})
    expect(hits).toContain("semiconductors")
  })
  it("returns empty when nothing matches", () => {
    expect(classifyTopics("Weather is nice.", topicSlugs, watchlists)).toEqual([])
  })
})

describe("HttpIngest paywall → RSS description fallback", () => {
  it("uses RSS description when extracted body is paywalled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-paywall-"))
    const paywalledHtml = `
<html><head><title>Prudential extends Japan sales pause</title></head>
<body><article>
<p>Prudential extends Japan sales pause after mis-selling scandal.</p>
<p>Subscribe to unlock this article</p>
<p>Try unlimited access</p>
<p>Only S$1 for 4 weeks. Then S$99 per month. Complete digital access.</p>
</article></body></html>`
    const description =
      "Prudential Financial has extended its sales suspension in Japan following a mis-selling scandal, deepening the distribution disruption for its life insurance and annuity products with Japanese retail savers. The FSA is expected to require broader conduct remediation."

    const program = Effect.gen(function* () {
      const svc = yield* IngestService
      return yield* svc.ingestUrl({
        url: "https://www.ft.com/content/prudential-japan",
        date: "2026-04-22",
        topicSlugs: ["japan-aging-healthcare"],
        minWordCount: 20,
        overwrite: false,
        descriptionFromFeed: description,
        topicWatchlists: { "japan-aging-healthcare": ["prudential", "mis-selling", "life insurance"] },
      })
    }).pipe(
      Effect.provide(
        HttpIngestLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystemVaultLive(dir),
              Layer.succeed(HttpIngestConfigTag, { fetch: mkFetch(paywalledHtml) }),
            ),
          ),
        ),
      ),
    )

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const res = exit.value
    expect(res.paywalled).toBe(true)
    expect(res.bodySource).toBe("rss_description")
    expect(res.topicsMatched).toEqual(["japan-aging-healthcare"])

    const onDisk = await readFile(join(dir, res.relPath), "utf8")
    const parsed = matter(onDisk)
    const quality = parsed.data.quality as { paywalled?: boolean; body_source?: string }
    expect(quality.paywalled).toBe(true)
    expect(quality.body_source).toBe("rss_description")
    // Body should contain the description, NOT the paywall boilerplate.
    expect(parsed.content).toContain("Prudential Financial has extended")
    expect(parsed.content).not.toContain("Only S$1 for 4 weeks")
  })

  it("keeps extracted body when not paywalled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-nopaywall-"))
    const html = `
<html><head><title>BoJ holds rates</title></head>
<body><article>
<p>The Bank of Japan held its policy rate at 0.75% today. Governor Ueda cited persistent inflation. Traders priced in a later hike. Yen weakened to 156.</p>
</article></body></html>`
    const program = Effect.gen(function* () {
      const svc = yield* IngestService
      return yield* svc.ingestUrl({
        url: "https://example.com/news/boj",
        date: "2026-04-22",
        topicSlugs: ["japan-macro"],
        minWordCount: 10,
        overwrite: false,
        descriptionFromFeed: "ignored short teaser",
        topicWatchlists: { "japan-macro": ["boj", "ueda", "yen"] },
      })
    }).pipe(
      Effect.provide(
        HttpIngestLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystemVaultLive(dir),
              Layer.succeed(HttpIngestConfigTag, { fetch: mkFetch(html) }),
            ),
          ),
        ),
      ),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.paywalled).toBe(false)
    expect(exit.value.bodySource).toBe("extracted")
    expect(exit.value.topicsMatched).toEqual(["japan-macro"])
  })

  it("rejects with low_quality when paywalled AND no useful description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-paywall-lowq-"))
    const paywalledHtml = `
<html><head><title>Some FT article</title></head>
<body><article>
<p>Lede.</p>
<p>Subscribe to unlock this article</p>
<p>Try unlimited access</p>
</article></body></html>`
    const program = Effect.gen(function* () {
      const svc = yield* IngestService
      return yield* svc.ingestUrl({
        url: "https://www.ft.com/content/x",
        date: "2026-04-22",
        topicSlugs: ["japan-macro"],
        minWordCount: 100,
        overwrite: false,
        descriptionFromFeed: "too short",
      })
    }).pipe(
      Effect.provide(
        HttpIngestLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystemVaultLive(dir),
              Layer.succeed(HttpIngestConfigTag, { fetch: mkFetch(paywalledHtml) }),
            ),
          ),
        ),
      ),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("narrows topics to forceTopics ∩ classified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-narrow-"))
    // Article about yen only; feed covers [japan-macro, us-politics, sg-property] — only japan-macro should survive.
    const html = `
<html><head><title>Yen moves</title></head>
<body><article>
<p>The yen weakened to 156 as the BoJ held rates. Ueda's press conference gave no new guidance.</p>
<p>Traders now price a later move. JGB yields flat.</p>
</article></body></html>`
    const program = Effect.gen(function* () {
      const svc = yield* IngestService
      return yield* svc.ingestUrl({
        url: "https://news.example.com/yen",
        date: "2026-04-22",
        topicSlugs: ["japan-macro", "us-politics", "sg-property"],
        minWordCount: 10,
        overwrite: false,
        forceTopics: ["japan-macro", "us-politics", "sg-property"],
        topicWatchlists: {
          "japan-macro": ["boj", "yen", "ueda", "jgb"],
          "us-politics": ["trump", "congress", "fomc"],
          "sg-property": ["hdb", "mas", "cooling-measures-sg"],
        },
      })
    }).pipe(
      Effect.provide(
        HttpIngestLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystemVaultLive(dir),
              Layer.succeed(HttpIngestConfigTag, { fetch: mkFetch(html) }),
            ),
          ),
        ),
      ),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.topicsMatched).toEqual(["japan-macro"])
  })
})
