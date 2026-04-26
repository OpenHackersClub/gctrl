import type { Schema } from "effect"
import type { TopicEntry } from "../schemas.js"

type Topic = Schema.Schema.Type<typeof TopicEntry>

// Google News exposes a stable RSS endpoint that takes any search query.
// We URL-encode the query and pin hl=en-US&gl=US&ceid=US:en so the result
// shape is deterministic across machines.
const GOOGLE_NEWS_BASE = "https://news.google.com/rss/search"

export const googleNewsUrl = (query: string): string => {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  })
  return `${GOOGLE_NEWS_BASE}?${params.toString()}`
}

const quote = (s: string) => `"${s.replace(/"/g, "")}"`

// Build the candidate feed URLs for a person topic. Returns an empty list
// for non-person topics or when discovery is explicitly disabled.
//
// The "interviews" flag adds a second Google News query scoped to interview-
// flavored terms — these turn up podcast appearances and Q&A transcripts
// that the bare-name query tends to miss.
export const personFeedUrls = (topic: Topic): ReadonlyArray<string> => {
  if (topic.kind !== "person") return []
  const discovery = topic.discovery ?? {}
  const enabled = discovery.google_news ?? true
  const urls: Array<string> = []

  if (enabled) {
    const aliases = topic.aliases ?? []
    // Quote the primary name so Google News treats "Sam Altman" as a phrase
    // instead of two loose tokens. Aliases are joined with OR so any surface
    // form qualifies a hit.
    const nameTerms = [topic.title, ...aliases].filter((s) => s.trim().length > 0)
    const dedup = Array.from(new Set(nameTerms))
    const nameClause =
      dedup.length === 1 ? quote(dedup[0]!) : dedup.map(quote).join(" OR ")
    urls.push(googleNewsUrl(nameClause))

    if (discovery.interviews ?? true) {
      // Mirror the BBC/Karpathy gist heuristic: interviews surface under
      // "interview", "podcast", or "talk" near the name.
      urls.push(googleNewsUrl(`${nameClause} (interview OR podcast OR talk)`))
    }
  }

  for (const f of discovery.feeds ?? []) {
    if (f.trim().length > 0) urls.push(f.trim())
  }
  return urls
}
