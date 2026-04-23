import { escapeHtml, renderMarkdown, renderMetaFooter } from "./markdown.ts"
import { type ListedObject, listUnder, SAFE_KEY_RE, stem } from "./vault.ts"

export type RenderedPage = Readonly<{
  status: number
  title: string
  bodyHtml: string
}>

const renderIndexHtml = (
  title: string,
  linkBase: string,
  items: ReadonlyArray<ListedObject>,
): string => {
  if (items.length === 0) {
    return `<h1>${escapeHtml(title)}</h1><p>No entries yet. Run <code>uber sync r2</code> after generating a report.</p>`
  }
  const rows = items
    .map((it) => {
      const s = stem(it.key)
      const when = it.uploaded ? it.uploaded.toISOString().slice(0, 10) : ""
      return `<li><time>${escapeHtml(when)}</time><a href="${linkBase}${encodeURIComponent(s)}">${escapeHtml(s)}</a></li>`
    })
    .join("")
  return `<h1>${escapeHtml(title)}</h1><ul class="index">${rows}</ul>`
}

export const renderHome = async (bucket: R2Bucket): Promise<RenderedPage> => {
  const [reports, briefs] = await Promise.all([
    listUnder(bucket, "reports/"),
    listUnder(bucket, "briefs/"),
  ])
  const bodyHtml = [
    `<h1>uebermensch</h1>`,
    `<p>Local-first chief-of-staff vault, synced here from R2. <span class="muted">(noindex; link-only)</span></p>`,
    renderIndexHtml("Reports", "/reports/", reports.slice(0, 20)),
    renderIndexHtml("Briefs", "/briefs/", briefs.slice(0, 20)),
  ].join("\n")
  return { status: 200, title: "uebermensch", bodyHtml }
}

export const renderIndex = async (
  bucket: R2Bucket,
  prefix: string,
  title: string,
  linkBase: string,
): Promise<RenderedPage> => {
  const items = await listUnder(bucket, prefix)
  return { status: 200, title, bodyHtml: renderIndexHtml(title, linkBase, items) }
}

export const renderNotFound = (path: string): RenderedPage => ({
  status: 404,
  title: "Not found",
  bodyHtml: `<h1>Not found</h1><p>No page at <code>${escapeHtml(path)}</code>.</p>`,
})

export const renderKey = async (
  bucket: R2Bucket,
  prefix: string,
  slug: string,
): Promise<RenderedPage> => {
  if (!SAFE_KEY_RE.test(slug)) return renderNotFound(`${prefix}${slug}`)
  const obj = await bucket.get(`${prefix}${slug}.md`)
  if (!obj) return renderNotFound(`${prefix}${slug}`)
  const raw = await obj.text()
  const rendered = renderMarkdown(raw)
  const title = rendered.title ?? slug
  const bodyHtml = `${rendered.html}${renderMetaFooter(rendered.frontmatter)}`
  return { status: 200, title, bodyHtml }
}
