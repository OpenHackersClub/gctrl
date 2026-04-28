import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { classifyTopics } from "../src/adapters/HttpIngest.js"
import { googleNewsUrl, personFeedUrls } from "../src/lib/discovery.js"
import { TopicEntry, TopicsConfig } from "../src/schemas.js"

describe("TopicEntry — person kind + aliases", () => {
  it("decodes a topic without kind (legacy default)", () => {
    const out = Schema.decodeUnknownSync(TopicEntry)({
      slug: "ai-dev-workflows",
      title: "AI dev workflows",
      horizon: "both",
      weight: 1.0,
    })
    expect(out.kind).toBeUndefined()
    expect(out.aliases).toBeUndefined()
  })

  it("decodes a person topic with aliases + discovery", () => {
    const out = Schema.decodeUnknownSync(TopicEntry)({
      slug: "sam-altman",
      title: "Sam Altman",
      kind: "person",
      horizon: "both",
      weight: 0.8,
      aliases: ["Sam Altman", "@sama"],
      discovery: { google_news: true, interviews: true },
    })
    expect(out.kind).toBe("person")
    expect(out.aliases).toEqual(["Sam Altman", "@sama"])
    expect(out.discovery?.interviews).toBe(true)
  })

  it("rejects unknown kinds", () => {
    expect(() =>
      Schema.decodeUnknownSync(TopicEntry)({
        slug: "x",
        title: "X",
        kind: "company",
        horizon: "both",
        weight: 1,
      }),
    ).toThrow()
  })

  it("decodes a TopicsConfig that mixes kinds", () => {
    const out = Schema.decodeUnknownSync(TopicsConfig)({
      topics: [
        { slug: "macro", title: "Macro", horizon: "long", weight: 0.5 },
        {
          slug: "sam-altman",
          title: "Sam Altman",
          kind: "person",
          horizon: "both",
          weight: 0.7,
          aliases: ["@sama"],
        },
      ],
    })
    expect(out.topics).toHaveLength(2)
  })
})

describe("classifyTopics — alias matching for person topics", () => {
  // The CLI merges aliases into the per-topic watchlist before calling
  // classifyTopics. This test mirrors that contract.
  it("matches a multi-word alias with spaces", () => {
    const text = "In a recent interview, Sam Altman said the company..."
    const hits = classifyTopics(text, ["sam-altman"], {
      "sam-altman": ["Sam Altman", "@sama"],
    })
    expect(hits).toEqual(["sam-altman"])
  })

  it("matches the @handle form of an alias", () => {
    const text = "thread by @sama on launch day"
    const hits = classifyTopics(text, ["sam-altman"], {
      "sam-altman": ["Sam Altman", "@sama"],
    })
    expect(hits).toEqual(["sam-altman"])
  })

  it("does not match when neither slug-phrase nor alias appears", () => {
    const text = "story about other people in tech"
    const hits = classifyTopics(text, ["sam-altman"], {
      "sam-altman": ["Sam Altman", "@sama"],
    })
    expect(hits).toEqual([])
  })

  it("still matches the kebab→space slug form", () => {
    // Person slug doubles as a watchlist seed: "sam-altman" → "sam altman".
    const text = "essay by sam altman on agi"
    const hits = classifyTopics(text, ["sam-altman"], { "sam-altman": [] })
    expect(hits).toEqual(["sam-altman"])
  })
})

describe("personFeedUrls + googleNewsUrl", () => {
  const baseTopic = {
    slug: "sam-altman",
    title: "Sam Altman",
    horizon: "both" as const,
    weight: 0.8,
  }

  it("returns [] for a non-person topic", () => {
    expect(personFeedUrls({ ...baseTopic, kind: "topic" })).toEqual([])
    expect(personFeedUrls(baseTopic)).toEqual([])
  })

  it("builds a Google News query quoting the title", () => {
    const urls = personFeedUrls({
      ...baseTopic,
      kind: "person",
      discovery: { google_news: true, interviews: false },
    })
    expect(urls).toHaveLength(1)
    const u = new URL(urls[0]!)
    expect(u.host).toBe("news.google.com")
    expect(u.pathname).toBe("/rss/search")
    expect(u.searchParams.get("q")).toBe('"Sam Altman"')
    expect(u.searchParams.get("hl")).toBe("en-US")
  })

  it("appends an interview-flavored query when interviews=true", () => {
    const urls = personFeedUrls({
      ...baseTopic,
      kind: "person",
      discovery: { google_news: true, interviews: true },
    })
    expect(urls).toHaveLength(2)
    expect(new URL(urls[1]!).searchParams.get("q")).toBe(
      '"Sam Altman" (interview OR podcast OR talk)',
    )
  })

  it("ORs aliases into the name clause", () => {
    const urls = personFeedUrls({
      ...baseTopic,
      kind: "person",
      aliases: ["Sam Altman", "@sama"],
      discovery: { google_news: true, interviews: false },
    })
    const q = new URL(urls[0]!).searchParams.get("q")!
    expect(q).toContain('"Sam Altman"')
    expect(q).toContain('"@sama"')
    expect(q).toContain(" OR ")
  })

  it("appends author-supplied feeds verbatim", () => {
    const urls = personFeedUrls({
      ...baseTopic,
      kind: "person",
      discovery: {
        google_news: false,
        interviews: false,
        feeds: ["https://blog.samaltman.com/posts.atom"],
      },
    })
    expect(urls).toEqual(["https://blog.samaltman.com/posts.atom"])
  })

  it("defaults google_news + interviews to true when discovery is omitted", () => {
    const urls = personFeedUrls({ ...baseTopic, kind: "person" })
    expect(urls).toHaveLength(2)
  })

  it("googleNewsUrl percent-encodes special chars", () => {
    const u = googleNewsUrl('"Yann LeCun" interview')
    expect(u).toContain("q=%22Yann+LeCun%22+interview")
  })
})
