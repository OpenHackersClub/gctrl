// Pure topic-matching for event suggestions (specs/events.md § Matching algorithm).
// Score = |keywords ∩ tokens| / max(1, |keywords|), thresholded by min_match_score.

const STOPWORDS = new Set([
  "the", "and", "or", "for", "of", "in", "on", "at", "to", "a", "an",
  "is", "are", "be", "by", "with", "from", "this", "that", "as",
  "it", "its", "into", "your", "our", "we", "you", "i",
])

const tokenise = (s: string): ReadonlyArray<string> =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))

// Build the keyword set from topics + free-form interests.
// Each topic.title and topic.aliases entry is split into tokens; events.interests
// strings are tokenised the same way. Returns a Set for fast intersection.
export const buildKeywords = (input: {
  topicTitles: ReadonlyArray<string>
  topicAliases: ReadonlyArray<string>
  interests: ReadonlyArray<string>
}): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const s of input.topicTitles) for (const t of tokenise(s)) out.add(t)
  for (const s of input.topicAliases) for (const t of tokenise(s)) out.add(t)
  for (const s of input.interests) for (const t of tokenise(s)) out.add(t)
  return out
}

// Tokenise the free-form text of an event.
export const eventTokens = (input: {
  title: string
  description?: string | null
  tags?: ReadonlyArray<string>
}): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const t of tokenise(input.title)) out.add(t)
  if (input.description) for (const t of tokenise(input.description)) out.add(t)
  if (input.tags) {
    for (const tag of input.tags) for (const t of tokenise(tag)) out.add(t)
  }
  return out
}

export type MatchResult = {
  readonly score: number
  readonly matched: ReadonlyArray<string>
}

export const scoreMatch = (
  keywords: ReadonlySet<string>,
  tokens: ReadonlySet<string>,
): MatchResult => {
  if (keywords.size === 0) return { score: 0, matched: [] }
  const matched: Array<string> = []
  for (const kw of keywords) if (tokens.has(kw)) matched.push(kw)
  matched.sort()
  return { score: matched.length / keywords.size, matched }
}
