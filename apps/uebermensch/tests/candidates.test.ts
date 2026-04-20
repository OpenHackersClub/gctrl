import { describe, expect, it } from "vitest"
import { scorePrior, selectCandidates } from "../src/lib/candidates.js"
import type { WikiPage } from "../src/services/VaultService.js"

const page = (
  overrides: Partial<WikiPage> & { frontmatter?: Record<string, unknown> },
): WikiPage => ({
  relPath: "wiki/sources/stub.md",
  stem: overrides.stem ?? "stub",
  frontmatter: {
    page_type: "source",
    slug: overrides.stem ?? "stub",
    topics: ["foo"],
    ...overrides.frontmatter,
  },
  body: "",
  mtime: overrides.mtime ?? new Date("2026-04-19T08:00:00Z"),
})

describe("selectCandidates", () => {
  const now = new Date("2026-04-19T12:00:00Z")
  const topics = [{ slug: "foo", weight: 1 }]

  it("filters by page_type (only source/synthesis/question)", () => {
    const pages = [
      page({ stem: "src-a", frontmatter: { page_type: "source", topics: ["foo"] } }),
      page({ stem: "ent-a", frontmatter: { page_type: "entity", topics: ["foo"] } }),
      page({ stem: "syn-a", frontmatter: { page_type: "synthesis", topics: ["foo"] } }),
      page({ stem: "top-a", frontmatter: { page_type: "topic", topics: ["foo"] } }),
    ]
    const got = selectCandidates({
      pages,
      topics,
      thesesSlugs: [],
      now,
      windowHours: 24,
      maxCandidates: 40,
    })
    expect(got.map((c) => c.page.stem).sort()).toEqual(["src-a", "syn-a"])
  })

  it("filters by window and topic intersection", () => {
    const stale = new Date(now.getTime() - 48 * 3_600_000)
    const pages = [
      page({ stem: "recent-match", mtime: now, frontmatter: { page_type: "source", topics: ["foo"] } }),
      page({ stem: "recent-miss", mtime: now, frontmatter: { page_type: "source", topics: ["bar"] } }),
      page({ stem: "stale-match", mtime: stale, frontmatter: { page_type: "source", topics: ["foo"] } }),
    ]
    const got = selectCandidates({
      pages,
      topics,
      thesesSlugs: [],
      now,
      windowHours: 24,
      maxCandidates: 40,
    })
    expect(got.map((c) => c.page.stem)).toEqual(["recent-match"])
  })

  it("drops spammy pages (spam_score >= 0.6)", () => {
    const pages = [
      page({
        stem: "spammy",
        frontmatter: { page_type: "source", topics: ["foo"], quality: { spam_score: 0.8 } },
      }),
      page({ stem: "clean", frontmatter: { page_type: "source", topics: ["foo"] } }),
    ]
    const got = selectCandidates({
      pages,
      topics,
      thesesSlugs: [],
      now,
      windowHours: 24,
      maxCandidates: 40,
    })
    expect(got.map((c) => c.page.stem)).toEqual(["clean"])
  })

  it("ranks newer pages higher under recency decay", () => {
    const older = new Date(now.getTime() - 10 * 3_600_000)
    const newer = new Date(now.getTime() - 1 * 3_600_000)
    const pA = page({ stem: "older", mtime: older })
    const pB = page({ stem: "newer", mtime: newer })
    const sA = scorePrior(pA, topics, [], now)
    const sB = scorePrior(pB, topics, [], now)
    expect(sB).toBeGreaterThan(sA)
  })

  it("applies thesis boost when page links a watched thesis", () => {
    const pThesis = page({
      stem: "with-thesis",
      frontmatter: { page_type: "source", topics: ["foo"], linked_thesis: ["t1"] },
    })
    const pPlain = page({ stem: "plain", frontmatter: { page_type: "source", topics: ["foo"] } })
    const sT = scorePrior(pThesis, topics, ["t1"], now)
    const sP = scorePrior(pPlain, topics, ["t1"], now)
    expect(sT).toBeGreaterThan(sP)
  })
})
