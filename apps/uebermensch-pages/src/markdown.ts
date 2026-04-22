import matter from "gray-matter"
import { marked } from "marked"

export type RenderedPage = {
  readonly html: string
  readonly frontmatter: Record<string, unknown>
  readonly title: string | null
}

// Safe-ish: only allow kebab/slug characters in the stem; anything else
// (spaces, punctuation) falls back to the raw text.
const STEM_RE = /^[a-z0-9][a-z0-9._-]*$/i

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

// Rewrite [[stem]] and [[stem|label]] before handing off to marked.
// Runs on raw markdown (not HTML) so we don't fight marked's AST.
// Protect fenced code + inline code so wikilinks inside snippets stay literal.
export const rewriteWikilinks = (md: string): string => {
  const fenceSplit = md.split(/(^```[\s\S]*?^```\s*$)/m)
  return fenceSplit
    .map((chunk, idx) => {
      if (idx % 2 === 1) return chunk // fenced block
      const inlineSplit = chunk.split(/(`[^`\n]+`)/g)
      return inlineSplit
        .map((piece, j) => {
          if (j % 2 === 1) return piece // inline code
          return piece.replace(/\[\[([^\]|\n]+)(?:\|([^\]]+))?\]\]/g, (raw, rawStem, rawLabel) => {
            const stem = String(rawStem).trim()
            const label = rawLabel ? String(rawLabel).trim() : stem
            if (!STEM_RE.test(stem)) return raw
            return `[${label}](/wiki/${encodeURIComponent(stem)})`
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

export const renderShell = (inner: string, title: string): string => {
  const safeTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fafafa; --muted:#666; --rule:#e5e5e5; --accent:#2563eb; --code-bg:#f0f0f0; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eaeaea; --bg:#111; --muted:#999; --rule:#2a2a2a; --accent:#60a5fa; --code-bg:#1e1e1e; } }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--fg); }
  body { font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 2rem 1.2rem 4rem; }
  header nav { font-size: .9rem; color: var(--muted); margin-bottom: 2rem; }
  header nav a { color: var(--muted); margin-right: 1rem; text-decoration: none; }
  header nav a:hover { color: var(--accent); }
  h1 { font-size: 1.9rem; margin: 0 0 .8rem; line-height: 1.2; }
  h2 { font-size: 1.35rem; margin: 2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid var(--rule); }
  h3 { font-size: 1.05rem; margin: 1.4rem 0 .4rem; }
  a { color: var(--accent); }
  blockquote { margin: .8rem 0; padding: .2rem .9rem; border-left: 3px solid var(--rule); color: var(--muted); font-style: italic; }
  pre,code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
  code { background: var(--code-bg); padding: .1rem .35rem; border-radius: 3px; font-size: .92em; }
  pre { background: var(--code-bg); padding: .8rem 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  ul.index { list-style: none; padding: 0; margin: 0; }
  ul.index li { margin: .2rem 0; display: flex; gap: 1rem; border-bottom: 1px dotted var(--rule); padding: .5rem 0; }
  ul.index li time { color: var(--muted); font-variant-numeric: tabular-nums; flex: 0 0 6rem; }
  footer.meta { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: .82rem; color: var(--muted); }
  footer.meta dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: 0; }
  footer.meta dt { color: var(--muted); }
  footer.meta dd { margin: 0; font-family: ui-monospace,Menlo,monospace; word-break: break-all; }
</style>
</head>
<body>
<main>
<header><nav><a href="/">home</a><a href="/reports/">reports</a><a href="/briefs/">briefs</a></nav></header>
${inner}
</main>
</body>
</html>`
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

export { escapeHtml }
