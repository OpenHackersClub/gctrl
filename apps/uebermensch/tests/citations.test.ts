import { describe, expect, it } from "vitest"
import {
  citedSentences,
  claimSentences,
  extractLinks,
  isTypedPrefix,
} from "../src/lib/citations.js"

describe("extractLinks", () => {
  it("parses bare and display-text wikilinks", () => {
    const md = "See [[alpha]] and [[beta|the Beta report]]."
    const links = extractLinks(md)
    expect(links).toHaveLength(2)
    expect(links[0]!.target).toBe("alpha")
    expect(links[0]!.display).toBeNull()
    expect(links[1]!.target).toBe("beta")
    expect(links[1]!.display).toBe("the Beta report")
  })

  it("ignores malformed link syntax", () => {
    const md = "No [[ ]] here. Nor [link] here."
    const links = extractLinks(md)
    expect(links).toHaveLength(1)
    expect(links[0]!.target).toBe("")
  })
})

describe("isTypedPrefix", () => {
  it.each([
    ["thesis:foo", true],
    ["foo/bar", true],
    ["foo\\bar", true],
    ["plain-slug", false],
    ["2026-04-18--foo", false],
  ])("%s -> %s", (target, expected) => {
    expect(isTypedPrefix(target)).toBe(expected)
  })
})

describe("claim/cited sentence counts", () => {
  it("counts sentences containing a wikilink", () => {
    const md = "Bare claim. Claim with [[alpha]] citation. And [[beta]] too!"
    expect(claimSentences(md)).toBe(3)
    expect(citedSentences(md)).toBe(2)
  })

  it("strips code fences", () => {
    const md = "```\nSome.\nThing.\n```\nReal [[alpha]] here."
    expect(claimSentences(md)).toBe(1)
    expect(citedSentences(md)).toBe(1)
  })
})
