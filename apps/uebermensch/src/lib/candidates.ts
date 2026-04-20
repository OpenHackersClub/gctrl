import type { WikiPage } from "../services/VaultService.js"

export type TopicWeight = { readonly slug: string; readonly weight: number }

export type CandidateRef = {
  readonly id: string
  readonly page: WikiPage
  readonly score: number
}

export type CandidateInput = {
  readonly pages: ReadonlyArray<WikiPage>
  readonly topics: ReadonlyArray<TopicWeight>
  readonly thesesSlugs: ReadonlyArray<string>
  readonly now: Date
  readonly windowHours: number
  readonly maxCandidates: number
}

const HALFLIFE_HOURS = 12
const MAX_CANDIDATE_TYPES = new Set(["source", "synthesis", "question"])

const recencyDecay = (page: WikiPage, now: Date): number => {
  const ageHours = Math.max(0, (now.getTime() - page.mtime.getTime()) / 3_600_000)
  return 2 ** (-ageHours / HALFLIFE_HOURS)
}

const topicWeightFor = (
  page: WikiPage,
  topics: ReadonlyArray<TopicWeight>,
): number => {
  const pageTopics = (page.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []
  if (pageTopics.length === 0) return 0.1
  let best = 0
  for (const t of pageTopics) {
    const match = topics.find((w) => w.slug === t)
    if (match && match.weight > best) best = match.weight
  }
  return best
}

const spamPenalty = (page: WikiPage): number => {
  const q = page.frontmatter.quality as { spam_score?: number } | undefined
  const score = q?.spam_score ?? 0
  return Math.max(0, 1 - score)
}

const thesisBoost = (
  page: WikiPage,
  thesesSlugs: ReadonlyArray<string>,
): number => {
  const watched = (page.frontmatter.watched_by_thesis as ReadonlyArray<string> | undefined) ?? []
  const linked = (page.frontmatter.linked_thesis as ReadonlyArray<string> | undefined) ?? []
  const touched = [...watched, ...linked]
  return touched.some((t) => thesesSlugs.includes(t)) ? 1.3 : 1.0
}

const pageType = (p: WikiPage): string =>
  (p.frontmatter.page_type as string | undefined)?.toLowerCase() ?? "unknown"

const spamScore = (p: WikiPage): number => {
  const q = p.frontmatter.quality as { spam_score?: number } | undefined
  return q?.spam_score ?? 0
}

const pageTopicSlugs = (p: WikiPage): ReadonlyArray<string> =>
  (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []

export const scorePrior = (
  page: WikiPage,
  topics: ReadonlyArray<TopicWeight>,
  thesesSlugs: ReadonlyArray<string>,
  now: Date,
): number => {
  const base = topicWeightFor(page, topics)
  if (base === 0) return 0
  return base * recencyDecay(page, now) * spamPenalty(page) * thesisBoost(page, thesesSlugs)
}

export const selectCandidates = (input: CandidateInput): ReadonlyArray<CandidateRef> => {
  const { pages, topics, thesesSlugs, now, windowHours, maxCandidates } = input
  const cutoff = now.getTime() - windowHours * 3_600_000
  const topicSlugs = new Set(topics.map((t) => t.slug))

  const filtered = pages.filter((p) => {
    if (p.mtime.getTime() < cutoff) return false
    if (!MAX_CANDIDATE_TYPES.has(pageType(p))) return false
    if (spamScore(p) >= 0.6) return false
    const pageTopics = pageTopicSlugs(p)
    const topicHit = pageTopics.some((t) => topicSlugs.has(t))
    const thesisHit = thesesSlugs.some((t) => {
      const watched = (p.frontmatter.watched_by_thesis as ReadonlyArray<string> | undefined) ?? []
      const linked = (p.frontmatter.linked_thesis as ReadonlyArray<string> | undefined) ?? []
      return watched.includes(t) || linked.includes(t)
    })
    return topicHit || thesisHit
  })

  const scored = filtered
    .map((page, i) => ({
      id: `cand-${i.toString().padStart(4, "0")}`,
      page,
      score: scorePrior(page, topics, thesesSlugs, now),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, maxCandidates)
}
