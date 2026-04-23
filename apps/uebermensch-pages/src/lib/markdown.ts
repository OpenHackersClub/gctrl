import matter from "gray-matter"
import { marked } from "marked"

export type RenderedPage = {
  readonly html: string
  readonly frontmatter: Record<string, unknown>
  readonly title: string | null
}

const STEM_RE = /^[a-z0-9][a-z0-9._-]*$/i
const WEEK_RE = /^\d{4}-W\d{2}(?:--.+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const routeFor = (stem: string): string => {
  const encoded = encodeURIComponent(stem)
  if (WEEK_RE.test(stem)) return `/reports/${encoded}`
  if (DATE_RE.test(stem)) return `/briefs/${encoded}`
  return `/wiki/${encoded}`
}

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

export const rewriteWikilinks = (md: string): string => {
  const fenceSplit = md.split(/(^```[\s\S]*?^```\s*$)/m)
  return fenceSplit
    .map((chunk, idx) => {
      if (idx % 2 === 1) return chunk
      const inlineSplit = chunk.split(/(`[^`\n]+`)/g)
      return inlineSplit
        .map((piece, j) => {
          if (j % 2 === 1) return piece
          return piece.replace(/\[\[([^\]|\n]+)(?:\|([^\]]+))?\]\]/g, (raw, rawStem, rawLabel) => {
            const stem = String(rawStem).trim()
            const label = rawLabel ? String(rawLabel).trim() : stem
            if (!STEM_RE.test(stem)) return raw
            return `[${label}](${routeFor(stem)})`
          })
        })
        .join("")
    })
    .join("")
}

marked.setOptions({ gfm: true, breaks: false })

export const renderMarkdown = (raw: string): RenderedPage => {
  const parsed = matter(raw)
  const rewritten = rewriteWikilinks(parsed.content)
  const html = marked.parse(rewritten, { async: false }) as string
  const fm = (parsed.data ?? {}) as Record<string, unknown>
  const title =
    (typeof fm.title === "string" && fm.title) ||
    (typeof fm.slug === "string" && fm.slug) ||
    null
  return { html, frontmatter: fm, title }
}

export const renderMetaFooter = (fm: Record<string, unknown>): string => {
  const keys = [
    "period_label",
    "generated_for",
    "kind",
    "generator",
    "model",
    "cost_usd",
    "section_count",
    "item_count",
    "cited_claims",
    "total_claims",
    "interests",
    "topics",
    "prompt_hash",
  ]
  const rows: Array<string> = []
  for (const k of keys) {
    const v = fm[k]
    if (v === undefined || v === null || v === "") continue
    const str = Array.isArray(v) ? (v as ReadonlyArray<unknown>).join(", ") : String(v)
    rows.push(`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(str)}</dd>`)
  }
  if (rows.length === 0) return ""
  return `<footer class="meta"><dl>${rows.join("")}</dl></footer>`
}
