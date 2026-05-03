import { describe, expect, it } from "vitest"
import {
  renderSourceBody,
  type SourceBodyInput,
  type RawMeta,
} from "../src/lib/source-body.js"
import type { SourceDigest } from "../src/lib/llm-prompts.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIGEST: SourceDigest = {
  gist: [
    "Japan lifted arms-export restrictions to 17 partner countries.",
    "The move targets lethal weapons for the first time in post-war history.",
    "Abe's 2014 reinterpretation paved the way; this cabinet vote finalised it.",
  ],
  key_numbers: ["17 partner countries", "¥800 billion defence budget FY2026"],
  essential_quotes: [
    {
      text: "This marks a historic shift in our approach to collective security.",
      attribution: "Chief Cabinet Secretary",
    },
  ],
  access: "open",
}

const FIXTURE_RAW: RawMeta = {
  fetchedAt: "2026-05-03T08:00:00Z",
  charCount: 14200,
  wordCount: 842,
  readabilityUsed: true,
  paywall: false,
}

const FIXTURE_INPUT: SourceBodyInput = {
  title: "Japan Lifts Arms Export Restrictions",
  url: "https://www.nikkei.com/article/arms-exports-2026",
  digest: FIXTURE_DIGEST,
  raw: FIXTURE_RAW,
  insights: [],
  questions: [],
}

// ---------------------------------------------------------------------------
// Section order + headings
// ---------------------------------------------------------------------------

describe("renderSourceBody — full input", () => {
  it("includes all six section headings", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("## Gist")
    expect(body).toContain("## Key numbers")
    expect(body).toContain("## Essential quotes")
    expect(body).toContain("## Insights")
    expect(body).toContain("## Questions")
    expect(body).toContain("## Access metadata")
  })

  it("sections appear in the spec-mandated order", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    const gistIdx = body.indexOf("## Gist")
    const keyNIdx = body.indexOf("## Key numbers")
    const quotesIdx = body.indexOf("## Essential quotes")
    const insightsIdx = body.indexOf("## Insights")
    const questionsIdx = body.indexOf("## Questions")
    const accessIdx = body.indexOf("## Access metadata")
    expect(gistIdx).toBeLessThan(keyNIdx)
    expect(keyNIdx).toBeLessThan(quotesIdx)
    expect(quotesIdx).toBeLessThan(insightsIdx)
    expect(insightsIdx).toBeLessThan(questionsIdx)
    expect(questionsIdx).toBeLessThan(accessIdx)
  })

  it("emits title header and url", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("# Japan Lifts Arms Export Restrictions")
    expect(body).toContain("Source: <https://www.nikkei.com/article/arms-exports-2026>")
  })

  it("renders gist bullets", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("- Japan lifted arms-export restrictions to 17 partner countries.")
    expect(body).toContain("- The move targets lethal weapons for the first time in post-war history.")
  })

  it("renders key numbers", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("- 17 partner countries")
    expect(body).toContain("- ¥800 billion defence budget FY2026")
  })

  it("renders essential quote with attribution", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("> \"This marks a historic shift in our approach to collective security.\"")
    expect(body).toContain("Chief Cabinet Secretary")
  })

  it("renders _None._ for empty insights on first ingest", () => {
    const body = renderSourceBody({ ...FIXTURE_INPUT, insights: [] })
    const insightsSection = body.slice(body.indexOf("## Insights"))
    expect(insightsSection).toContain("_None._")
  })

  it("renders _None._ for empty questions on first ingest", () => {
    const body = renderSourceBody({ ...FIXTURE_INPUT, questions: [] })
    const questionsSection = body.slice(body.indexOf("## Questions"))
    expect(questionsSection).toContain("_None._")
  })

  it("renders provided insights as bullets", () => {
    const body = renderSourceBody({
      ...FIXTURE_INPUT,
      insights: ["This source strengthens [[llm-tooling-consolidation]] thesis.", "Watch for follow-on legislation."],
    })
    expect(body).toContain("- This source strengthens [[llm-tooling-consolidation]] thesis.")
    expect(body).toContain("- Watch for follow-on legislation.")
  })

  it("renders provided questions as bullets", () => {
    const body = renderSourceBody({
      ...FIXTURE_INPUT,
      questions: ["What is the timeline for the first live export under the new rules?"],
    })
    expect(body).toContain("- What is the timeline for the first live export under the new rules?")
  })

  it("renders access metadata bullets with raw stats", () => {
    const body = renderSourceBody(FIXTURE_INPUT)
    expect(body).toContain("- fetched_at: 2026-05-03T08:00:00Z")
    expect(body).toContain("- extraction_method: readability")
    expect(body).toContain("- paywall: false")
    expect(body).toContain("- raw_char_count: 14200")
    expect(body).toContain("- post_extraction_word_count: 842")
  })

  it("shows html-strip extraction_method when readabilityUsed=false", () => {
    const body = renderSourceBody({
      ...FIXTURE_INPUT,
      raw: { ...FIXTURE_RAW, readabilityUsed: false },
    })
    expect(body).toContain("- extraction_method: html-strip")
  })
})

// ---------------------------------------------------------------------------
// Empty-array edge cases
// ---------------------------------------------------------------------------

describe("renderSourceBody — empty gist / key numbers / quotes", () => {
  const emptyDigest: SourceDigest = {
    gist: [],
    key_numbers: [],
    essential_quotes: [],
    access: "paywall",
  }

  it("renders _None._ for empty gist", () => {
    const body = renderSourceBody({ ...FIXTURE_INPUT, digest: emptyDigest })
    const gistSection = body.slice(body.indexOf("## Gist"), body.indexOf("## Key numbers"))
    expect(gistSection).toContain("_None._")
  })

  it("renders _None._ for empty key_numbers", () => {
    const body = renderSourceBody({ ...FIXTURE_INPUT, digest: emptyDigest })
    const knSection = body.slice(body.indexOf("## Key numbers"), body.indexOf("## Essential quotes"))
    expect(knSection).toContain("_None._")
  })

  it("renders _None._ for empty essential_quotes", () => {
    const body = renderSourceBody({ ...FIXTURE_INPUT, digest: emptyDigest })
    const quotesSection = body.slice(body.indexOf("## Essential quotes"), body.indexOf("## Insights"))
    expect(quotesSection).toContain("_None._")
  })
})

// ---------------------------------------------------------------------------
// Digest-only overload (migration path)
// ---------------------------------------------------------------------------

describe("renderSourceBody — digest-only overload", () => {
  it("accepts a bare SourceDigest and emits the four LLM sections", () => {
    const body = renderSourceBody(FIXTURE_DIGEST)
    expect(body).toContain("## Gist")
    expect(body).toContain("## Key numbers")
    expect(body).toContain("## Essential quotes")
    expect(body).toContain("## Insights")
    expect(body).toContain("## Questions")
  })

  it("does NOT include a title header or Access metadata section", () => {
    const body = renderSourceBody(FIXTURE_DIGEST)
    expect(body).not.toContain("# Japan")
    expect(body).not.toContain("## Access metadata")
  })

  it("renders _None._ for Insights and Questions in digest-only form", () => {
    const body = renderSourceBody(FIXTURE_DIGEST)
    const insightsIdx = body.indexOf("## Insights")
    const questionsIdx = body.indexOf("## Questions")
    const insightsSection = body.slice(insightsIdx, questionsIdx)
    const questionsSection = body.slice(questionsIdx)
    expect(insightsSection).toContain("_None._")
    expect(questionsSection).toContain("_None._")
  })

  it("renders gist bullets from the digest", () => {
    const body = renderSourceBody(FIXTURE_DIGEST)
    expect(body).toContain("- Japan lifted arms-export restrictions to 17 partner countries.")
  })
})
