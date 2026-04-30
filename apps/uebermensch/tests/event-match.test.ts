import { describe, expect, it } from "vitest"
import { buildKeywords, eventTokens, scoreMatch } from "../src/lib/event-match.js"

describe("event-match — buildKeywords", () => {
  it("merges topic titles, aliases, and interests, dropping stopwords", () => {
    const kw = buildKeywords({
      topicTitles: ["Artificial Intelligence", "Prediction Markets"],
      topicAliases: ["AI", "ML"],
      interests: ["the futures of llms"],
    })
    expect(kw.has("artificial")).toBe(true)
    expect(kw.has("intelligence")).toBe(true)
    expect(kw.has("prediction")).toBe(true)
    expect(kw.has("markets")).toBe(true)
    expect(kw.has("ai")).toBe(true)
    expect(kw.has("ml")).toBe(true)
    expect(kw.has("llms")).toBe(true)
    expect(kw.has("the")).toBe(false)
    expect(kw.has("of")).toBe(false)
  })
})

describe("event-match — scoreMatch", () => {
  const keywords = buildKeywords({
    topicTitles: ["AI Infrastructure"],
    topicAliases: [],
    interests: ["llms"],
  })
  // keywords now: { ai, infrastructure, llms }

  it("returns 0 with no overlap", () => {
    const tokens = eventTokens({ title: "Pottery class for beginners" })
    const r = scoreMatch(keywords, tokens)
    expect(r.score).toBe(0)
    expect(r.matched).toEqual([])
  })

  it("returns 1.0 when every keyword is matched", () => {
    const tokens = eventTokens({
      title: "AI Infrastructure meetup",
      description: "Talk on LLMs",
    })
    const r = scoreMatch(keywords, tokens)
    expect(r.score).toBeCloseTo(1, 5)
    expect([...r.matched].sort()).toEqual(["ai", "infrastructure", "llms"])
  })

  it("partial match returns proportion", () => {
    const tokens = eventTokens({ title: "AI startup demo" })
    const r = scoreMatch(keywords, tokens)
    expect(r.score).toBeCloseTo(1 / 3, 5)
    expect(r.matched).toEqual(["ai"])
  })

  it("matched terms are deduped against tags", () => {
    const tokens = eventTokens({
      title: "AI talk",
      tags: ["ai", "infrastructure"],
    })
    const r = scoreMatch(keywords, tokens)
    expect([...r.matched].sort()).toEqual(["ai", "infrastructure"])
  })

  it("empty keyword set returns 0 (avoids div-by-zero)", () => {
    const empty = buildKeywords({ topicTitles: [], topicAliases: [], interests: [] })
    const tokens = eventTokens({ title: "anything" })
    expect(scoreMatch(empty, tokens).score).toBe(0)
  })
})
