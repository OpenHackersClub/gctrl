import { describe, expect, it } from "vitest"
import { renderMarkdown, renderMetaFooter, rewriteWikilinks, routeFor } from "../src/lib/markdown.ts"

describe("routeFor", () => {
  it("routes weekly report index stems to /reports/", () => {
    expect(routeFor("2026-W17")).toBe("/reports/2026-W17")
  })
  it("routes per-interest weekly report stems to /reports/", () => {
    expect(routeFor("2026-W17--japan-macro")).toBe("/reports/2026-W17--japan-macro")
  })
  it("routes bare date stems to /briefs/", () => {
    expect(routeFor("2026-04-23")).toBe("/briefs/2026-04-23")
  })
  it("routes dated source stems to /wiki/", () => {
    expect(routeFor("2026-04-22--wikipedia-boj")).toBe("/wiki/2026-04-22--wikipedia-boj")
  })
  it("routes bare entity stems to /wiki/", () => {
    expect(routeFor("donald-trump")).toBe("/wiki/donald-trump")
  })
})

describe("rewriteWikilinks", () => {
  it("rewrites wiki-source stems to /wiki/ links", () => {
    const out = rewriteWikilinks("See [[2026-04-22--wikipedia-boj]].")
    expect(out).toContain("[2026-04-22--wikipedia-boj](/wiki/2026-04-22--wikipedia-boj)")
  })
  it("rewrites weekly-report stems to /reports/ links", () => {
    const out = rewriteWikilinks("Read [[2026-W17--japan-macro|Japan macro]].")
    expect(out).toContain("[Japan macro](/reports/2026-W17--japan-macro)")
  })
  it("rewrites bare-date stems to /briefs/ links", () => {
    const out = rewriteWikilinks("From [[2026-04-23]].")
    expect(out).toContain("[2026-04-23](/briefs/2026-04-23)")
  })
  it("uses the label when provided", () => {
    const out = rewriteWikilinks("See [[my-note|the note]].")
    expect(out).toContain("[the note](/wiki/my-note)")
  })
  it("leaves unsafe stems alone", () => {
    const out = rewriteWikilinks("See [[/etc/passwd]].")
    expect(out).toBe("See [[/etc/passwd]].")
  })
  it("does not rewrite inside inline code", () => {
    const out = rewriteWikilinks("Call `[[stem]]` in prose")
    expect(out).toBe("Call `[[stem]]` in prose")
  })
  it("does not rewrite inside fenced code", () => {
    const md = "before\n```\n[[stem]]\n```\nafter [[stem]]"
    const out = rewriteWikilinks(md)
    expect(out).toContain("```\n[[stem]]\n```")
    expect(out).toContain("after [stem](/wiki/stem)")
  })
})

describe("renderMarkdown", () => {
  it("renders frontmatter + wikilinks + body", () => {
    const raw = `---
page_type: report
slug: report-2026-W17
title: Weekly report — 2026-W17
cost_usd: 0.40
---

# Heading

Body with [[2026-04-22--boj]] inside.
`
    const { html, frontmatter, title } = renderMarkdown(raw)
    expect(title).toBe("Weekly report — 2026-W17")
    expect(frontmatter.slug).toBe("report-2026-W17")
    expect(html).toContain("<h1>")
    expect(html).toContain('href="/wiki/2026-04-22--boj"')
  })
})

describe("renderMetaFooter", () => {
  it("renders known keys only", () => {
    const html = renderMetaFooter({ model: "claude-opus-4-7", cost_usd: 0.4, nope: "x" })
    expect(html).toContain("model")
    expect(html).toContain("claude-opus-4-7")
    expect(html).toContain("0.4")
    expect(html).not.toContain("nope")
  })
  it("returns empty string when nothing to render", () => {
    expect(renderMetaFooter({})).toBe("")
  })
})
