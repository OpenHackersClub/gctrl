import { XMLParser } from "fast-xml-parser"

export type FeedItem = {
  readonly title: string
  readonly link: string
  readonly publishedAt: Date | null
  readonly guid: string | null
  readonly description: string | null
}

export type FeedFormat = "rss2" | "atom" | "unknown"

export type ParsedFeed = {
  readonly format: FeedFormat
  readonly title: string
  readonly items: ReadonlyArray<FeedItem>
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: "#cdata",
  textNodeName: "#text",
})

const asArray = <T>(v: T | ReadonlyArray<T> | undefined | null): ReadonlyArray<T> => {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? (v as ReadonlyArray<T>) : [v as T]
}

const textOf = (v: unknown): string => {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v.trim()
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    if (typeof o["#cdata"] === "string") return (o["#cdata"] as string).trim()
    if (typeof o["#text"] === "string") return (o["#text"] as string).trim()
    // Atom <title type="html">…</title> often nests differently.
    for (const key of Object.keys(o)) {
      if (key.startsWith("@_")) continue
      const t = textOf(o[key])
      if (t) return t
    }
  }
  return ""
}

const parseDate = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

const atomLink = (links: unknown): string => {
  for (const l of asArray<unknown>(links as ReadonlyArray<unknown>)) {
    if (typeof l === "string") return l.trim()
    if (typeof l === "object" && l !== null) {
      const o = l as Record<string, unknown>
      const rel = (o["@_rel"] as string | undefined) ?? "alternate"
      const href = (o["@_href"] as string | undefined) ?? textOf(l)
      if (rel === "alternate" && href) return href.trim()
    }
  }
  // Fallback: first link's href regardless of rel.
  for (const l of asArray<unknown>(links as ReadonlyArray<unknown>)) {
    if (typeof l === "object" && l !== null) {
      const href = (l as Record<string, unknown>)["@_href"] as string | undefined
      if (href) return href.trim()
    }
  }
  return ""
}

const parseRss2 = (root: Record<string, unknown>): ParsedFeed => {
  const channel = (root.channel as Record<string, unknown> | undefined) ?? {}
  const items = asArray<Record<string, unknown>>(
    channel.item as Record<string, unknown> | ReadonlyArray<Record<string, unknown>> | undefined,
  ).map<FeedItem>((item) => {
    const linkRaw = item.link
    const link =
      typeof linkRaw === "string"
        ? linkRaw.trim()
        : textOf(linkRaw) ||
          (typeof linkRaw === "object" && linkRaw !== null
            ? ((linkRaw as Record<string, unknown>)["@_href"] as string | undefined) ?? ""
            : "")
    const guidRaw = item.guid
    const guid =
      typeof guidRaw === "string"
        ? guidRaw.trim()
        : typeof guidRaw === "object" && guidRaw !== null
          ? textOf(guidRaw)
          : null
    return {
      title: textOf(item.title),
      link,
      publishedAt: parseDate(
        textOf(item.pubDate) || textOf((item as Record<string, unknown>)["dc:date"]),
      ),
      guid: guid || null,
      description: textOf(item.description) || null,
    }
  })
  return {
    format: "rss2",
    title: textOf(channel.title),
    items,
  }
}

const parseAtom = (feed: Record<string, unknown>): ParsedFeed => {
  const items = asArray<Record<string, unknown>>(
    feed.entry as Record<string, unknown> | ReadonlyArray<Record<string, unknown>> | undefined,
  ).map<FeedItem>((entry) => ({
    title: textOf(entry.title),
    link: atomLink(entry.link),
    publishedAt: parseDate(textOf(entry.updated) || textOf(entry.published)),
    guid: textOf(entry.id) || null,
    description: textOf(entry.summary) || textOf(entry.content) || null,
  }))
  return {
    format: "atom",
    title: textOf(feed.title),
    items,
  }
}

export const parseFeed = (xml: string): ParsedFeed => {
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    return { format: "unknown", title: "", items: [] }
  }
  const rss = doc.rss as Record<string, unknown> | undefined
  if (rss) return parseRss2(rss)
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined
  if (rdf) return parseRss2(rdf) // RSS 1.0 items at top level — same shape
  const feed = doc.feed as Record<string, unknown> | undefined
  if (feed) return parseAtom(feed)
  return { format: "unknown", title: "", items: [] }
}
