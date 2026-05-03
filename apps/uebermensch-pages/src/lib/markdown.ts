import matter from "gray-matter"
import { marked } from "marked"

export type RenderedPage = {
  readonly html: string
  readonly frontmatter: Record<string, unknown>
  readonly title: string | null
}

export type ReferenceEntry = {
  readonly n: number
  readonly title: string
  readonly canonical_url: string
  readonly domain: string
  readonly accessed_at: string
  readonly source_page_slug?: string
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

/**
 * Rewrites `[n]` numeric citation markers outside code fences / inline code / existing anchors
 * into `<sup><a id="cite-n" href="#ref-n" class="cite-marker">[n]</a></sup>`.
 *
 * The replacement happens in the rendered HTML (after markdown parse) so we can safely skip
 * code / pre blocks by splitting on them.
 */
export const rewriteCitationMarkers = (html: string): string => {
  // Split on <code>...</code>, <pre>...</pre>, and <a ...>...</a> blocks to avoid rewriting
  // citation markers that appear inside those elements.
  const SKIP_RE = /(<(?:pre|code)[^>]*>[\s\S]*?<\/(?:pre|code)>|<a[^>]*>[\s\S]*?<\/a>)/gi
  const parts = html.split(SKIP_RE)
  return parts
    .map((part, idx) => {
      // Odd-indexed parts are the captured skip blocks — leave them untouched.
      if (idx % 2 === 1) return part
      // Replace [n] with superscript anchor — only bare numeric references.
      return part.replace(/\[(\d+)\]/g, (_match, n: string) => {
        return `<sup><a id="cite-${n}" href="#ref-${n}" class="cite-marker">[${n}]</a></sup>`
      })
    })
    .join("")
}

/**
 * Renders the styled `<ol class="references">` footer block from a list of reference entries.
 */
export const renderReferencesSection = (refs: ReadonlyArray<ReferenceEntry>): string => {
  if (refs.length === 0) return `<ol class="references"></ol>`
  const items = refs
    .map((ref) => {
      const digestLink =
        ref.source_page_slug
          ? ` · <a href="/wiki/${encodeURIComponent(ref.source_page_slug)}" class="digest-link">view digest</a>`
          : ""
      return (
        `<li id="ref-${ref.n}">` +
        `<a href="#cite-${ref.n}">[${ref.n}]</a> ` +
        `<strong>${escapeHtml(ref.title)}</strong> — ` +
        `<span class="domain-chip">${escapeHtml(ref.domain)}</span>` +
        ` · <time>${escapeHtml(ref.accessed_at)}</time>` +
        ` · <a href="${escapeHtml(ref.canonical_url)}" rel="noopener noreferrer" target="_blank">↗</a>` +
        `${digestLink}` +
        `</li>`
      )
    })
    .join("")
  return `<ol class="references">${items}</ol>`
}

/**
 * Given rendered HTML that contains a `<h2>References</h2>` heading followed by a `<ul>` or `<ol>`,
 * replace that block with `rendered` (the pre-built styled references HTML).
 * Returns the HTML unchanged if no such block is found.
 */
const replaceReferencesBlock = (html: string, rendered: string): string => {
  // Match <h2>References</h2> (with optional whitespace/attributes) followed by a list block.
  return html.replace(
    /<h2[^>]*>\s*References\s*<\/h2>\s*<[uo]l[\s\S]*?<\/[uo]l>/i,
    `<h2>References</h2>\n${rendered}`,
  )
}

/**
 * Parses a raw `references[]` array from frontmatter into typed ReferenceEntry objects.
 * Entries that lack required fields are silently dropped.
 */
const parseFrontmatterRefs = (raw: unknown): ReadonlyArray<ReferenceEntry> => {
  if (!Array.isArray(raw)) return []
  const out: Array<ReferenceEntry> = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const r = item as Record<string, unknown>
    const n = typeof r["n"] === "number" ? r["n"] : typeof r["n"] === "string" ? parseInt(r["n"], 10) : NaN
    const title = typeof r["title"] === "string" ? r["title"] : ""
    const canonical_url = typeof r["canonical_url"] === "string" ? r["canonical_url"] : ""
    const domain = typeof r["domain"] === "string" ? r["domain"] : ""
    const accessed_at = typeof r["accessed_at"] === "string" ? r["accessed_at"] : ""
    const source_page_slug = typeof r["source_page_slug"] === "string" ? r["source_page_slug"] : undefined
    if (!Number.isFinite(n) || !title || !canonical_url || !domain || !accessed_at) continue
    out.push({ n, title, canonical_url, domain, accessed_at, source_page_slug })
  }
  return out
}

/**
 * Warns (does not throw) if a `[[slug]]`-resolved link targets a source page from inside a
 * brief/report/synthesis body — Citation Mode v1 requires numeric `[n]` markers for external
 * sources. Pre-migration vault files still render; this is a console.warn, not a hard error.
 */
export const warnIfSourceCitedInline = (
  linkingPageType: string | undefined,
  targetPageType: string | undefined,
  targetSlug: string,
): void => {
  const briefLike = new Set(["brief", "report", "synthesis"])
  if (
    typeof linkingPageType === "string" &&
    briefLike.has(linkingPageType) &&
    targetPageType === "source"
  ) {
    console.warn(
      `[uebermensch-pages] Citation Mode v1 violation: ` +
      `page_type "${linkingPageType}" links to source page "${targetSlug}" via [[slug]]. ` +
      `Use a numeric [n] marker + references[] entry instead (R3).`,
    )
  }
}

marked.setOptions({ gfm: true, breaks: false })

export const renderMarkdown = (raw: string): RenderedPage => {
  const parsed = matter(raw)
  const rewritten = rewriteWikilinks(parsed.content)
  let html = marked.parse(rewritten, { async: false }) as string
  const fm = (parsed.data ?? {}) as Record<string, unknown>

  // Apply citation marker rewriting after wikilink rewriting + standard markdown render.
  html = rewriteCitationMarkers(html)

  // If frontmatter carries a references[] array, prefer it over body-parsed list.
  const fmRefs = parseFrontmatterRefs(fm["references"])
  if (fmRefs.length > 0) {
    const refsHtml = renderReferencesSection(fmRefs)
    // Replace any existing References block in the body, or append if missing.
    const replaced = replaceReferencesBlock(html, refsHtml)
    if (replaced !== html) {
      html = replaced
    } else {
      // No existing block — append after body.
      html = `${html}\n<h2>References</h2>\n${refsHtml}`
    }
  } else {
    // No frontmatter refs — still style any body-parsed References block if present.
    html = replaceReferencesBlock(html, `<ol class="references"></ol>`)
  }

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
