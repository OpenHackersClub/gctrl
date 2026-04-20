export type ExtractedPage = {
  readonly title: string
  readonly text: string
  readonly wordCount: number
  readonly publishedAt: string | null
}

const BLOCK_LEVEL_TAGS =
  /<\/?(p|div|section|article|header|footer|nav|aside|main|br|li|ul|ol|h[1-6]|blockquote|pre|table|tr|td|th|figure|figcaption)\b[^>]*>/gi

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))

const stripBlock = (html: string, tagRe: RegExp): string => html.replace(tagRe, "")

const extractTag = (html: string, tag: string): string | null => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  const m = re.exec(html)
  return m?.[1] ?? null
}

const extractMetaContent = (html: string, nameOrProp: string): string | null => {
  const re = new RegExp(
    `<meta\\s+(?:(?:name|property)\\s*=\\s*["']${nameOrProp}["'])[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  )
  const m = re.exec(html)
  if (m?.[1]) return m[1]
  // flipped order (content before name)
  const reFlipped = new RegExp(
    `<meta\\s+[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${nameOrProp}["'][^>]*>`,
    "i",
  )
  return reFlipped.exec(html)?.[1] ?? null
}

const collapseWhitespace = (s: string): string =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export const extractFromHtml = (html: string): ExtractedPage => {
  const title =
    extractMetaContent(html, "og:title") ??
    extractTag(html, "title")?.trim() ??
    "Untitled"
  const publishedAt =
    extractMetaContent(html, "article:published_time") ??
    extractMetaContent(html, "datePublished") ??
    null

  // Prefer the body (or main/article) region
  let region = extractTag(html, "article") ?? extractTag(html, "main") ?? extractTag(html, "body") ?? html
  region = stripBlock(region, /<script[\s\S]*?<\/script>/gi)
  region = stripBlock(region, /<style[\s\S]*?<\/style>/gi)
  region = stripBlock(region, /<noscript[\s\S]*?<\/noscript>/gi)
  region = stripBlock(region, /<!--[\s\S]*?-->/g)
  region = region.replace(BLOCK_LEVEL_TAGS, "\n")
  region = region.replace(/<[^>]+>/g, "")
  const text = collapseWhitespace(decodeEntities(region))
  const wordCount = text.split(/\s+/).filter(Boolean).length
  return { title: decodeEntities(title).trim(), text, wordCount, publishedAt }
}

export const domainKebab = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  return host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export const slugForSource = (url: string, date: string): string => `${date}--${domainKebab(url)}`
