import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
import matter from "gray-matter"
import { describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import {
  HttpIngestConfigTag,
  HttpIngestLive,
} from "../src/adapters/HttpIngest.js"
import { IngestError } from "../src/errors.js"
import { domainKebab, extractFromHtml, slugForSource } from "../src/lib/html-extract.js"
import { IngestService } from "../src/services/IngestService.js"

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
})

describe("slug + domain helpers", () => {
  it("kebabs hostname and strips www", () => {
    expect(domainKebab("https://www.Anthropic.COM/news/claude")).toBe("anthropic-com")
    expect(domainKebab("https://blog.example.co.uk/post")).toBe("blog-example-co-uk")
  })
  it("slugForSource combines date + domain", () => {
    expect(slugForSource("https://www.anthropic.com/news/x", "2026-04-20")).toBe(
      "2026-04-20--anthropic-com",
    )
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
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const res = exit.value
    expect(res.slug).toBe("2026-04-20--example-com")
    expect(res.relPath).toBe("wiki/sources/2026-04-20--example-com.md")
    expect(res.title).toBe("Big Story About AI")
    expect(res.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect([...res.topicsMatched].sort()).toEqual(["ai", "markets"])

    const onDisk = await readFile(join(dir, res.relPath), "utf8")
    const parsed = matter(onDisk)
    expect(parsed.data.page_type).toBe("source")
    expect(parsed.data.slug).toBe("2026-04-20--example-com")
    expect(parsed.data.url).toBe(seedReq.url)
    expect(parsed.data.domain).toBe("example.com")
    expect((parsed.data.quality as { word_count: number }).word_count).toBeGreaterThan(10)
    expect(parsed.content).toContain("Big Story About AI")
  })

  it("rejects below-threshold content with kind=low_quality", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const html = `<html><body><p>tiny</p></body></html>`
    const exit = await runIngest(dir, mkFetch(200, html))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = Exit.match(exit, {
        onFailure: (c) => JSON.stringify(c),
        onSuccess: () => "",
      })
      expect(err).toContain("low_quality")
    }
  })

  it("maps non-200 to kind=fetch_failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const exit = await runIngest(dir, mkFetch(500, "boom"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("fetch_failed")
    }
  })

  it("refuses to overwrite existing source unless --overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-ingest-"))
    const html = `<html><head><title>T</title></head><body><article>${"word ".repeat(50)}</article></body></html>`
    const first = await runIngest(dir, mkFetch(200, html))
    expect(first._tag).toBe("Success")
    const second = await runIngest(dir, mkFetch(200, html))
    expect(second._tag).toBe("Failure")

    const overwrite = await runIngest(dir, mkFetch(200, html), { ...seedReq, overwrite: true })
    expect(overwrite._tag).toBe("Success")
  })

  it("IngestError is tagged correctly", () => {
    const err = new IngestError({ message: "x", kind: "fetch_failed", url: "u" })
    expect(err._tag).toBe("IngestError")
    expect(err.kind).toBe("fetch_failed")
  })
})
