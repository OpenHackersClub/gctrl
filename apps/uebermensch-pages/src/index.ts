import { Hono, type Context } from "hono"
import { escapeHtml, renderMarkdown, renderMetaFooter, renderShell } from "./markdown.ts"

export type Bindings = {
  readonly VAULT: R2Bucket
}

type AppContext = Context<{ Bindings: Bindings }>

const app = new Hono<{ Bindings: Bindings }>()

const SAFE_KEY_RE = /^[a-z0-9._-]+$/i

const notFound = (c: AppContext, path: string) =>
  c.html(
    renderShell(
      `<h1>Not found</h1><p>No page at <code>${escapeHtml(path)}</code>.</p>`,
      "Not found",
    ),
    404,
  )

// Generic prefix listing: returns { key, uploaded } for .md objects under prefix/.
const listUnder = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<ReadonlyArray<{ key: string; uploaded: Date | null }>> => {
  const out: Array<{ key: string; uploaded: Date | null }> = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i += 1) {
    const page = await bucket.list({ prefix, cursor, limit: 500 })
    for (const obj of page.objects) {
      if (!obj.key.endsWith(".md")) continue
      out.push({ key: obj.key, uploaded: obj.uploaded ?? null })
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  // Sort newest first by uploaded, fallback to key desc.
  out.sort((a, b) => {
    const at = a.uploaded ? a.uploaded.getTime() : 0
    const bt = b.uploaded ? b.uploaded.getTime() : 0
    if (bt !== at) return bt - at
    return b.key.localeCompare(a.key)
  })
  return out
}

const stem = (key: string): string => {
  const slash = key.lastIndexOf("/")
  const base = slash >= 0 ? key.slice(slash + 1) : key
  return base.replace(/\.md$/, "")
}

const renderIndex = (
  title: string,
  linkBase: string,
  items: ReadonlyArray<{ key: string; uploaded: Date | null }>,
): string => {
  if (items.length === 0) {
    return `<h1>${escapeHtml(title)}</h1><p>No entries yet. Run <code>uber sync r2</code> after generating a report.</p>`
  }
  const rows = items
    .map((it) => {
      const s = stem(it.key)
      const when = it.uploaded
        ? it.uploaded.toISOString().slice(0, 10)
        : ""
      return `<li><time>${escapeHtml(when)}</time><a href="${linkBase}${encodeURIComponent(s)}">${escapeHtml(s)}</a></li>`
    })
    .join("")
  return `<h1>${escapeHtml(title)}</h1><ul class="index">${rows}</ul>`
}

app.get("/", async (c) => {
  const [reports, briefs] = await Promise.all([
    listUnder(c.env.VAULT, "reports/"),
    listUnder(c.env.VAULT, "briefs/"),
  ])
  const inner = [
    `<h1>uebermensch</h1>`,
    `<p>Local-first chief-of-staff vault, synced here from R2. <span class="muted">(noindex; link-only)</span></p>`,
    renderIndex("Reports", "/reports/", reports.slice(0, 20)),
    renderIndex("Briefs", "/briefs/", briefs.slice(0, 20)),
  ].join("\n")
  return c.html(renderShell(inner, "uebermensch"))
})

app.get("/reports/", async (c) => {
  const items = await listUnder(c.env.VAULT, "reports/")
  return c.html(renderShell(renderIndex("Reports", "/reports/", items), "Reports"))
})

app.get("/briefs/", async (c) => {
  const items = await listUnder(c.env.VAULT, "briefs/")
  return c.html(renderShell(renderIndex("Briefs", "/briefs/", items), "Briefs"))
})

const renderKey = async (c: AppContext, prefix: string, slug: string) => {
  if (!SAFE_KEY_RE.test(slug)) return notFound(c, `${prefix}${slug}`)
  const key = `${prefix}${slug}.md`
  const obj = await c.env.VAULT.get(key)
  if (!obj) return notFound(c, `${prefix}${slug}`)
  const raw = await obj.text()
  const rendered = renderMarkdown(raw)
  const heading = rendered.title ?? slug
  const inner = `${rendered.html}${renderMetaFooter(rendered.frontmatter)}`
  return c.html(renderShell(inner, heading))
}

app.get("/reports/:slug", (c) => renderKey(c, "reports/", c.req.param("slug")))
app.get("/briefs/:slug", (c) => renderKey(c, "briefs/", c.req.param("slug")))
app.get("/wiki/:slug", (c) => renderKey(c, "wiki/sources/", c.req.param("slug")))

app.get("/robots.txt", (c) =>
  c.text("User-agent: *\nDisallow: /\n", 200, { "content-type": "text/plain" }),
)

app.notFound((c) => notFound(c, c.req.path))

export default app
