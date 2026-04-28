import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import matter from "gray-matter"
import { describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import {
  HttpIngestConfigTag,
  HttpIngestLive,
} from "../src/adapters/HttpIngest.js"
import { IngestError, LlmError } from "../src/errors.js"
import { cleanBoilerplate, domainKebab, extractFromHtml, slugForSource } from "../src/lib/html-extract.js"
import { IngestService } from "../src/services/IngestService.js"
import { LlmService } from "../src/services/LlmService.js"

describe("html-extract", () => {
  it("pulls title from <title> and strips scripts/styles", () => {
    const html = `
      <html><head>
        <title>Example Title</title>
        <meta property="article:published_time" content="2026-04-18T12:00:00Z" />
      </head><body>
        <script>alert(1)</script>
        <style>body{color:red}</style>
        <article>
          <h1>Hello</h1>
          <p>This is a long paragraph about something important.</p>
          <p>And a second one with <a href="#">a link</a>.</p>
        </article>
      </body></html>
    `
    const got = extractFromHtml(html)
    expect(got.title).toBe("Example Title")
    expect(got.publishedAt).toBe("2026-04-18T12:00:00Z")
    expect(got.text).toContain("Hello")
    expect(got.text).toContain("long paragraph")
    expect(got.text).not.toContain("alert(1)")
    expect(got.text).not.toContain("color:red")
    expect(got.wordCount).toBeGreaterThan(10)
  })

  it("prefers og:title when present", () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="OG Preferred" />
    </head><body><p>body</p></body></html>`
    expect(extractFromHtml(html).title).toBe("OG Preferred")
  })

  it("decodes entities", () => {
    const html = `<html><body><article><p>Tom &amp; Jerry &#8212; &quot;pals&quot;</p></article></body></html>`
    expect(extractFromHtml(html).text).toContain('Tom & Jerry')
    expect(extractFromHtml(html).text).toContain('"pals"')
  })

  it("drops nav/header/footer/aside content so UI chrome does not leak in", () => {
    const html = `<html><body>
      <header><nav><a href="/">home</a><a href="/reports">reports</a></nav></header>
      <article>
        <p>The real lede of the article is here and is substantive.</p>
        <p>A second paragraph with actual reporting from the ground.</p>
      </article>
      <aside>Add as preferred on Google</aside>
      <footer>ShareSave</footer>
    </body></html>`
    const out = extractFromHtml(html)
    expect(out.text).toContain("real lede")
    expect(out.text).not.toMatch(/home\s+reports/i)
    expect(out.text).not.toMatch(/add as preferred on google/i)
    expect(out.text).not.toMatch(/sharesave/i)
  })

  it("strips BBC-style chrome lines embedded in article body", () => {
    const html = `<html><body><article>
      <p>Headline Re-Stated</p>
      <p>1 day ago</p>
      <p>ShareSave</p>
      <p>Add as preferred on Google</p>
      <p>AFP via Getty Images</p>
      <p>The substantive first paragraph of the article explains the policy shift.</p>
      <p>AFP via Getty Images</p>
      <p>A second paragraph with more context about what is actually happening.</p>
      <p>Asia</p>
      <p>Japan</p>
    </article></body></html>`
    const out = extractFromHtml(html)
    expect(out.text).toContain("substantive first paragraph")
    expect(out.text).toContain("more context")
    expect(out.text).not.toMatch(/^ShareSave$/m)
    expect(out.text).not.toMatch(/^1 day ago/im)
    expect(out.text).not.toMatch(/add as preferred on google/i)
    expect(out.text).not.toMatch(/afp via getty images/i)
    // trailing single-word tags should be pruned
    expect(out.text.trim().endsWith("Japan")).toBe(false)
    expect(out.text.trim().endsWith("Asia")).toBe(false)
  })
})

describe("cleanBoilerplate", () => {
  it("collapses adjacent duplicate lines", () => {
    const input = "Photo\nPhoto\nThe real first paragraph carries on normally."
    expect(cleanBoilerplate(input)).not.toMatch(/Photo\nPhoto/)
  })

  it("keeps real quoted lines even when short", () => {
    const input = [
      "\"We must keep going,\" said the senator.",
      "Quote ends here but discussion continues in follow-up reporting.",
    ].join("\n")
    const out = cleanBoilerplate(input)
    expect(out).toContain("keep going")
  })
})

describe("slug + domain helpers", () => {
  it("kebabs hostname and strips www", () => {
    expect(domainKebab("https://www.Anthropic.COM/news/claude")).toBe("anthropic-com")
    expect(domainKebab("https://blog.example.co.uk/post")).toBe("blog-example-co-uk")
  })
  it("slugForSource combines date + domain + path stem", () => {
    expect(slugForSource("https://www.anthropic.com/news/claude-4-7", "2026-04-20")).toBe(
      "2026-04-20--anthropic-com--claude-4-7",
    )
  })
  it("slugForSource disambiguates two paths on the same domain + date", () => {
    const a = slugForSource("https://en.wikipedia.org/wiki/Bank_of_Japan", "2026-04-22")
    const b = slugForSource("https://en.wikipedia.org/wiki/Aging_of_Japan", "2026-04-22")
    expect(a).not.toBe(b)
  })
  it("slugForSource falls back to URL hash when path is empty", () => {
    const s = slugForSource("https://example.com/", "2026-04-20")
    expect(s).toMatch(/^2026-04-20--example-com--[0-9a-f]{8}$/)
  })
})

const mkFetch = (status: number, body: string, headers: Record<string, string> = {}): typeof fetch =>
  (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html", ...headers },
    })) as unknown as typeof fetch

const seedReq = {
  url: "https://example.com/news/big-story",
  date: "2026-04-20",
  topicSlugs: ["ai", "markets"],
  minWordCount: 10,
  overwrite: false,
}

const runIngest = async (vaultDir: string, fakeFetch: typeof fetch, req = seedReq) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* IngestService
      return yield* svc.ingestUrl(req)
    }).pipe(
      Effect.provide(
        HttpIngestLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystemVaultLive(vaultDir),
              Layer.succeed(HttpIngestConfigTag, { fetch: fakeFetch }),
            ),
          ),
        ),
      ),
    ),
  )

describe("HttpIngest adapter", () => {
  it("writes a source page with frontmatter + hashed content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const html = `
      <html><head><title>Big Story About AI</title></head>
      <body><article>
        <p>The AI industry continues to evolve rapidly this quarter.</p>
        <p>Markets responded with a sharp move in tech equities.</p>
      </article></body></html>`
    const exit = await runIngest(dir, mkFetch(200, html))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const res = exit.value
    expect(res.slug).toBe("2026-04-20--example-com--big-story")
    expect(res.relPath).toBe("wiki/sources/2026-04-20--example-com--big-story.md")
    expect(res.title).toBe("Big Story About AI")
    expect(res.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect([...res.topicsMatched].sort()).toEqual(["ai", "markets"])

    const onDisk = await readFile(join(dir, res.relPath), "utf8")
    const parsed = matter(onDisk)
    expect(parsed.data.page_type).toBe("source")
    expect(parsed.data.slug).toBe("2026-04-20--example-com--big-story")
    expect(parsed.data.url).toBe(seedReq.url)
    expect(parsed.data.domain).toBe("example.com")
    expect((parsed.data.quality as { word_count: number }).word_count).toBeGreaterThan(10)
    expect(parsed.content).toContain("Big Story About AI")
  })

  const failureKind = <E extends { kind?: string }>(exit: Exit.Exit<unknown, E>): string | null =>
    Exit.match(exit, {
      onSuccess: () => null,
      onFailure: (cause) =>
        Option.match(Cause.failureOption(cause), {
          onNone: () => null,
          onSome: (e) => e.kind ?? null,
        }),
    })

  it("rejects below-threshold content with kind=low_quality", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const html = `<html><body><p>tiny</p></body></html>`
    const exit = await runIngest(dir, mkFetch(200, html))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureKind(exit)).toBe("low_quality")
  })

  it("maps non-200 to kind=fetch_failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const exit = await runIngest(dir, mkFetch(500, "boom"))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureKind(exit)).toBe("fetch_failed")
  })

  it("refuses to overwrite existing source unless --overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const html = `<html><head><title>T</title></head><body><article>${"word ".repeat(50)}</article></body></html>`
    const first = await runIngest(dir, mkFetch(200, html))
    expect(Exit.isSuccess(first)).toBe(true)
    const second = await runIngest(dir, mkFetch(200, html))
    expect(Exit.isFailure(second)).toBe(true)
    expect(failureKind(second)).toBe("collision")

    const overwrite = await runIngest(dir, mkFetch(200, html), { ...seedReq, overwrite: true })
    expect(Exit.isSuccess(overwrite)).toBe(true)
  })

  it("IngestError carries kind + url as schema fields", () => {
    const err = new IngestError({ message: "x", kind: "fetch_failed", url: "u" })
    expect(err).toBeInstanceOf(IngestError)
    expect(err.kind).toBe("fetch_failed")
    expect(err.url).toBe("u")
  })
})

describe("HttpIngest with summarization", () => {
  const fakeLlmLayer = (insights: string, calls: { count: number }) =>
    Layer.succeed(LlmService, {
      name: () => "fake-llm",
      generateBrief: () => Effect.die("not used"),
      proposeSubtopic: () => Effect.die("not used"),
      generateInterestReport: () => Effect.die("not used"),
      researchQuery: () => Effect.die("not used"),
      summarizeSource: () =>
        Effect.sync(() => {
          calls.count += 1
          return {
            insightsMd: insights,
            promptHash: "sha256:deadbeef",
            costUsd: 0.0001,
            model: "fake-llm@1",
          }
        }),
    })

  const runIngestWithLlm = async (
    vaultDir: string,
    fakeFetch: typeof fetch,
    llmLayer: Layer.Layer<LlmService>,
    req: typeof seedReq & { summarize: boolean },
  ) => {
    const ingestLayer = HttpIngestLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystemVaultLive(vaultDir),
          Layer.succeed(HttpIngestConfigTag, { fetch: fakeFetch }),
        ),
      ),
    )
    return Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* IngestService
        return yield* svc.ingestUrl(req)
      }).pipe(Effect.provide(Layer.mergeAll(ingestLayer, llmLayer))),
    )
  }

  it("replaces body with LLM insights when summarize=true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-sum-"))
    const longBody = `<p>${"sentence about Tokyo arms exports. ".repeat(40)}</p>`
    const html = `<html><head><title>Arms Exports</title></head><body><article>${longBody}</article></body></html>`
    const calls = { count: 0 }
    const insights =
      "## Key Insights\n\n- Japan lifted arms-export restrictions to 17 partner countries.\n- The move targets lethal weapons for the first time.\n"
    const exit = await runIngestWithLlm(
      dir,
      mkFetch(200, html),
      fakeLlmLayer(insights, calls),
      { ...seedReq, summarize: true },
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls.count).toBe(1)
    if (!Exit.isSuccess(exit)) return
    const res = exit.value
    expect(res.bodySource).toBe("llm_insights")
    expect(res.summaryModel).toBe("fake-llm@1")

    const onDisk = await readFile(join(dir, res.relPath), "utf8")
    const parsed = matter(onDisk)
    expect(parsed.content).toContain("Key Insights")
    expect(parsed.content).toContain("17 partner countries")
    expect(parsed.content).not.toContain("sentence about Tokyo arms exports")
    expect((parsed.data.quality as { body_source: string }).body_source).toBe("llm_insights")
    expect((parsed.data.summary as { model: string }).model).toBe("fake-llm@1")
  })

  it("falls back to extracted body when LLM fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-sum-"))
    const html = `<html><head><title>T</title></head><body><article>${"word ".repeat(50)}</article></body></html>`
    const failingLlm = Layer.succeed(LlmService, {
      name: () => "broken-llm",
      generateBrief: () => Effect.die("not used"),
      proposeSubtopic: () => Effect.die("not used"),
      generateInterestReport: () => Effect.die("not used"),
      researchQuery: () => Effect.die("not used"),
      summarizeSource: () =>
        Effect.fail(new LlmError({ message: "upstream 503", kind: "unavailable" })),
    })
    const exit = await runIngestWithLlm(dir, mkFetch(200, html), failingLlm, {
      ...seedReq,
      summarize: true,
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.bodySource).toBe("extracted")
  })

  it("skips LLM entirely when summarize=false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-sum-"))
    const html = `<html><head><title>T</title></head><body><article>${"word ".repeat(50)}</article></body></html>`
    const calls = { count: 0 }
    const exit = await runIngestWithLlm(
      dir,
      mkFetch(200, html),
      fakeLlmLayer("## Key Insights\n- x", calls),
      { ...seedReq, summarize: false },
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls.count).toBe(0)
  })
})
