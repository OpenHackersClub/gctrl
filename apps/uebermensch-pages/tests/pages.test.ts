import { describe, expect, it } from "vitest"
import { renderHome, renderIndex, renderKey } from "../src/lib/pages.ts"

const makeR2 = (files: Record<string, { body: string; uploaded?: Date }>): R2Bucket => {
  const bucket: R2Bucket = {
    async get(key: string) {
      const hit = files[key]
      if (!hit) return null
      return {
        key,
        uploaded: hit.uploaded ?? new Date(),
        async text() {
          return hit.body
        },
      } as unknown as R2ObjectBody
    },
    async head() {
      return null
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const objects = Object.entries(files)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({
          key: k,
          size: v.body.length,
          uploaded: v.uploaded ?? new Date(),
          etag: "",
          httpEtag: "",
          checksums: {},
        }))
      return {
        objects,
        truncated: false,
        delimitedPrefixes: [],
      } as unknown as R2Objects
    },
    async put() {
      throw new Error("not implemented in stub")
    },
    async delete() {},
    async createMultipartUpload() {
      throw new Error("not implemented in stub")
    },
    async resumeMultipartUpload() {
      throw new Error("not implemented in stub")
    },
  } as unknown as R2Bucket
  return bucket
}

const sampleReport = `---
page_type: report
slug: report-2026-W17
kind: "weekly"
title: Weekly report 2026-W17
cost_usd: 0.4
model: claude-opus-4-7
---

# Weekly research report

Cites [[2026-04-22--wikipedia-boj]] and [[2026-04-22--wikipedia-2026-senate]].
`

const sampleWiki = `---
page_type: source
slug: 2026-04-22--wikipedia-boj
title: Bank of Japan
---

# Bank of Japan

The BoJ set its policy rate at 0.75%.
`

describe("renderHome", () => {
  it("lists reports and briefs, newest first", async () => {
    const bucket = makeR2({
      "reports/2026-W17.md": { body: sampleReport, uploaded: new Date("2026-04-22T10:00Z") },
      "reports/2026-W16.md": { body: sampleReport, uploaded: new Date("2026-04-15T10:00Z") },
      "briefs/2026-04-22.md": { body: sampleReport, uploaded: new Date("2026-04-22T07:00Z") },
      "wiki/sources/2026-04-22--wikipedia-boj.md": { body: sampleWiki },
    })
    const result = await renderHome(bucket)
    expect(result.status).toBe(200)
    expect(result.bodyHtml).toContain("2026-W17")
    expect(result.bodyHtml).toContain("2026-W16")
    expect(result.bodyHtml).toContain("2026-04-22")
    expect(result.bodyHtml.indexOf("2026-W17")).toBeLessThan(result.bodyHtml.indexOf("2026-W16"))
  })

  it("returns an empty-state message when the vault has no items", async () => {
    const result = await renderHome(makeR2({}))
    expect(result.status).toBe(200)
    expect(result.bodyHtml).toContain("No entries yet")
  })
})

describe("renderIndex", () => {
  it("lists only the requested prefix", async () => {
    const bucket = makeR2({
      "reports/2026-W17.md": { body: sampleReport, uploaded: new Date("2026-04-22T10:00Z") },
      "briefs/morning-summary.md": { body: sampleReport, uploaded: new Date("2026-04-22T07:00Z") },
    })
    const result = await renderIndex(bucket, "reports/", "Reports", "/reports/")
    expect(result.bodyHtml).toContain('href="/reports/2026-W17"')
    expect(result.bodyHtml).not.toContain("morning-summary")
    expect(result.bodyHtml).not.toContain("/briefs/")
  })
})

describe("renderKey", () => {
  it("renders markdown, frontmatter meta, and wikilinks", async () => {
    const bucket = makeR2({
      "reports/2026-W17.md": { body: sampleReport },
    })
    const result = await renderKey(bucket, "reports/", "2026-W17")
    expect(result.status).toBe(200)
    expect(result.title).toBe("Weekly report 2026-W17")
    expect(result.bodyHtml).toContain("<h1>Weekly research report</h1>")
    expect(result.bodyHtml).toContain('href="/wiki/2026-04-22--wikipedia-boj"')
    expect(result.bodyHtml).toContain("claude-opus-4-7")
  })

  it("returns 404 for missing slugs", async () => {
    const result = await renderKey(makeR2({}), "reports/", "nope")
    expect(result.status).toBe(404)
    expect(result.title).toBe("Not found")
  })

  it("resolves wiki stems under wiki/sources/", async () => {
    const bucket = makeR2({
      "wiki/sources/2026-04-22--wikipedia-boj.md": { body: sampleWiki },
    })
    const result = await renderKey(bucket, "wiki/sources/", "2026-04-22--wikipedia-boj")
    expect(result.status).toBe(200)
    expect(result.bodyHtml).toContain("Bank of Japan")
    expect(result.bodyHtml).toContain("0.75%")
  })

  it("rejects unsafe slugs with 404", async () => {
    const result = await renderKey(makeR2({}), "wiki/sources/", "../etc/passwd")
    expect(result.status).toBe(404)
  })
})
