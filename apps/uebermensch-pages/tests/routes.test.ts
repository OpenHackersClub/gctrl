import { describe, expect, it } from "vitest"
import app from "../src/index.ts"

// Minimal R2Bucket stub covering the surface the app uses.
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

const env = (files: Record<string, { body: string; uploaded?: Date }>) => ({
  VAULT: makeR2(files),
})

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

describe("pages routes", () => {
  it("GET / lists reports and briefs", async () => {
    const files = {
      "reports/2026-W17.md": { body: sampleReport, uploaded: new Date("2026-04-22T10:00Z") },
      "reports/2026-W16.md": { body: sampleReport, uploaded: new Date("2026-04-15T10:00Z") },
      "briefs/2026-04-22.md": { body: sampleReport, uploaded: new Date("2026-04-22T07:00Z") },
      "wiki/sources/2026-04-22--wikipedia-boj.md": { body: sampleWiki },
    }
    const res = await app.fetch(new Request("http://x/"), env(files))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("2026-W17")
    expect(html).toContain("2026-W16")
    expect(html).toContain("2026-04-22")
    // newest first
    expect(html.indexOf("2026-W17")).toBeLessThan(html.indexOf("2026-W16"))
  })

  it("GET /reports/:slug renders markdown + wikilinks", async () => {
    const files = {
      "reports/2026-W17.md": { body: sampleReport },
      "wiki/sources/2026-04-22--wikipedia-boj.md": { body: sampleWiki },
    }
    const res = await app.fetch(new Request("http://x/reports/2026-W17"), env(files))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<h1>Weekly research report</h1>")
    expect(html).toContain('href="/wiki/2026-04-22--wikipedia-boj"')
    expect(html).toContain("claude-opus-4-7")
  })

  it("GET /reports/:missing returns 404", async () => {
    const res = await app.fetch(new Request("http://x/reports/nope"), env({}))
    expect(res.status).toBe(404)
  })

  it("GET /wiki/:stem returns the source page", async () => {
    const files = {
      "wiki/sources/2026-04-22--wikipedia-boj.md": { body: sampleWiki },
    }
    const res = await app.fetch(
      new Request("http://x/wiki/2026-04-22--wikipedia-boj"),
      env(files),
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Bank of Japan")
    expect(html).toContain("0.75%")
  })

  it("rejects unsafe slugs with 404", async () => {
    const res = await app.fetch(new Request("http://x/wiki/..%2Fetc%2Fpasswd"), env({}))
    expect(res.status).toBe(404)
  })

  it("serves robots.txt disallowing all", async () => {
    const res = await app.fetch(new Request("http://x/robots.txt"), env({}))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Disallow: /")
  })
})
