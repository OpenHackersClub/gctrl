import { Context, Effect, Layer } from "effect"
import { IngestError, type VaultError } from "../errors.js"
import { domainKebab, extractFromHtml, slugForSource } from "../lib/html-extract.js"
import { sha256 } from "../lib/hash.js"
import { IngestService } from "../services/IngestService.js"
import { VaultService } from "../services/VaultService.js"

export type HttpIngestConfig = {
  readonly fetch?: typeof fetch
  readonly userAgent?: string
}

export class HttpIngestConfigTag extends Context.Tag("uebermensch/HttpIngestConfig")<
  HttpIngestConfigTag,
  HttpIngestConfig
>() {}

const DEFAULT_UA = "uebermensch-ingest/0.1 (+https://github.com/OpenHackersClub/gctrl)"
const MAX_BODY_CHARS = 8000

const ingestErr = (kind: IngestError["kind"], url: string, message: string): IngestError =>
  new IngestError({ kind, url, message })

const vaultToIngest = (url: string) => (e: VaultError): IngestError =>
  ingestErr(e.kind === "collision" ? "collision" : "io_failure", url, e.message)

const classifyTopics = (
  text: string,
  topicSlugs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const haystack = text.toLowerCase()
  const hits: Array<string> = []
  for (const slug of topicSlugs) {
    const needle = slug.toLowerCase().replace(/-/g, " ")
    if (haystack.includes(needle)) hits.push(slug)
  }
  return hits
}

const yamlEscape = (s: string): string => {
  if (/^[A-Za-z0-9._\-:/ ]+$/.test(s) && !s.includes(": ") && !s.startsWith("-")) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

const renderFrontmatter = (fields: Record<string, unknown>): string => {
  const lines: Array<string> = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      const items = value.map((v) => yamlEscape(String(v))).join(", ")
      lines.push(`${key}: [${items}]`)
    } else if (typeof value === "object") {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === null || v === undefined) continue
        lines.push(`  ${k}: ${yamlEscape(String(v))}`)
      }
    } else {
      lines.push(`${key}: ${yamlEscape(String(value))}`)
    }
  }
  lines.push("---")
  return lines.join("\n")
}

const renderSourceBody = (title: string, url: string, text: string): string => {
  const truncated =
    text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n…(truncated)` : text
  return [`# ${title}`, "", `Source: <${url}>`, "", truncated, ""].join("\n")
}

export const HttpIngestLive = Layer.effect(
  IngestService,
  Effect.gen(function* () {
    const config = yield* HttpIngestConfigTag
    const vault = yield* VaultService
    const doFetch = config.fetch ?? fetch
    const userAgent = config.userAgent ?? DEFAULT_UA

    return {
      ingestUrl: (req) =>
        Effect.gen(function* () {
          const fetchedAt = new Date().toISOString()

          const response = yield* Effect.tryPromise({
            try: () => doFetch(req.url, { headers: { "user-agent": userAgent } }),
            catch: (e) => ingestErr("fetch_failed", req.url, `fetch failed: ${String(e)}`),
          }).pipe(
            Effect.filterOrFail(
              (r) => r.ok,
              (r) => ingestErr("fetch_failed", req.url, `fetch returned ${r.status}`),
            ),
          )

          const html = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (e) => ingestErr("fetch_failed", req.url, `read body failed: ${String(e)}`),
          })

          const extracted = yield* Effect.try({
            try: () => extractFromHtml(html),
            catch: (e) => ingestErr("extract_failed", req.url, `extract failed: ${String(e)}`),
          }).pipe(
            Effect.filterOrFail(
              (x) => x.wordCount >= req.minWordCount,
              (x) =>
                ingestErr(
                  "low_quality",
                  req.url,
                  `word_count ${x.wordCount} < min ${req.minWordCount}`,
                ),
            ),
          )

          const slug = slugForSource(req.url, req.date)
          const domain = domainKebab(req.url).replace(/-/g, ".")
          const topicsMatched = classifyTopics(
            `${extracted.title}\n${extracted.text.slice(0, 2000)}`,
            req.topicSlugs,
          )
          const contentHash = sha256(extracted.text)

          const body = renderSourceBody(extracted.title, req.url, extracted.text)
          const frontmatter = renderFrontmatter({
            page_type: "source",
            slug,
            title: extracted.title,
            url: req.url,
            domain,
            published_at: extracted.publishedAt,
            fetched_at: fetchedAt,
            topics: topicsMatched,
            entities: [],
            content_hash: contentHash,
            quality: {
              word_count: extracted.wordCount,
              readability_used: false,
              spam_score: 0,
            },
          })
          const full = `${frontmatter}\n\n${body}`

          const written = yield* vault
            .writeSource(slug, full, { overwrite: req.overwrite })
            .pipe(Effect.catchTag("VaultError", (e) => Effect.fail(vaultToIngest(req.url)(e))))

          return {
            slug,
            relPath: written.relPath,
            absPath: written.absPath,
            title: extracted.title,
            domain,
            wordCount: extracted.wordCount,
            topicsMatched,
            contentHash: written.contentHash,
          }
        }),
    }
  }),
)

export const HttpIngestDefaultConfig = Layer.succeed(HttpIngestConfigTag, {})
