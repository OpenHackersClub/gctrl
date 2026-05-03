import { Effect, Layer } from "effect"
import { ProfileError } from "../errors.js"
import {
  buildKeywords,
  eventTokens,
  scoreMatch,
} from "../lib/event-match.js"
import { fetchLumaEvents, type LumaError, lumaCityUrl, type FetchFn } from "../lib/luma.js"
import { CalendarService, type SuggestionInput } from "../services/CalendarService.js"
import {
  EventSuggesterService,
  type SuggestPullInput,
  type SuggestionWritten,
} from "../services/EventSuggesterService.js"
import { ProfileService } from "../services/ProfileService.js"

const DEFAULT_MIN_MATCH = 0.2
const DEFAULT_LIMIT = 100
const GENERATOR = "driver-events.luma"

export type LumaSuggesterDeps = {
  readonly fetch?: FetchFn
}

const resolveCity = (
  flagCity: string | undefined,
  profileCity: string | undefined,
): Effect.Effect<string, ProfileError> => {
  const c = (flagCity ?? profileCity ?? "").trim()
  if (c.length === 0) {
    return Effect.fail(
      new ProfileError({
        message:
          "no city configured: pass --city or set identity.city in profile.md",
      }),
    )
  }
  return Effect.succeed(c)
}

export const LumaSuggesterLive = (deps: LumaSuggesterDeps = {}) =>
  Layer.effect(
    EventSuggesterService,
    Effect.gen(function* () {
      const cal = yield* CalendarService
      const profileSvc = yield* ProfileService
      return {
        pull: (input: SuggestPullInput) =>
          Effect.gen(function* () {
            const loaded = yield* profileSvc.load()
            const city = yield* resolveCity(input.city, loaded.profile.identity.city)
            const minMatch =
              input.minMatchScore ??
              loaded.profile.events?.min_match_score ??
              DEFAULT_MIN_MATCH
            const limit = input.limit ?? DEFAULT_LIMIT

            // Build keyword set from topics + profile.events.interests + CLI flag.
            const topicTitles = loaded.topics.topics.map((t) => t.title)
            const topicAliases = loaded.topics.topics.flatMap((t) => t.aliases ?? [])
            const profileInterests = loaded.profile.events?.interests ?? []
            const cliInterests = input.interests ?? []
            const keywords = buildKeywords({
              topicTitles,
              topicAliases,
              interests: [...profileInterests, ...cliInterests],
            })
            // Topic-slug list (only those whose tokens hit, surfaced on the
            // suggestion's `topics:` frontmatter for downstream filtering).
            const topicSlugByToken = new Map<string, string>()
            for (const t of loaded.topics.topics) {
              const seed = [t.title, ...(t.aliases ?? [])]
              for (const s of seed) {
                for (const tok of s
                  .toLowerCase()
                  .split(/[^a-z0-9]+/)
                  .filter((x) => x.length > 1)) {
                  if (!topicSlugByToken.has(tok)) topicSlugByToken.set(tok, t.slug)
                }
              }
            }

            const cityUrl = yield* lumaCityUrl(city).pipe(
              Effect.mapError(
                (e: LumaError) =>
                  new ProfileError({ message: `invalid city: ${e.message}` }),
              ),
            )
            const fetched = yield* fetchLumaEvents(cityUrl, { fetch: deps.fetch }).pipe(
              Effect.mapError(
                (e: LumaError) =>
                  new ProfileError({
                    message: `luma fetch failed for ${cityUrl}: ${e.message}`,
                  }),
              ),
            )

            const written: Array<SuggestionWritten> = []
            let matchedCount = 0
            let skippedDismissed = 0

            for (const ev of fetched.slice(0, limit)) {
              const tokens = eventTokens({
                title: ev.title,
                description: ev.description,
                tags: ev.tags,
              })
              const m = scoreMatch(keywords, tokens)
              if (m.score < minMatch) continue
              matchedCount += 1

              const matchedTopicSlugs = new Set<string>()
              for (const term of m.matched) {
                const slug = topicSlugByToken.get(term)
                if (slug) matchedTopicSlugs.add(slug)
              }

              const fallbackTz = loaded.profile.identity.tz
              const tags = ["meetup", "event-suggestion", "source:luma", ...ev.tags]
              const inputForCal: SuggestionInput = {
                title: ev.title,
                startsAt: ev.startsAt,
                endsAt: ev.endsAt ?? undefined,
                tz: ev.tz ?? fallbackTz,
                location: ev.location ?? undefined,
                url: ev.url || undefined,
                description: ev.description ?? undefined,
                externalId: ev.externalId,
                externalEtag: ev.externalId,
                topics: [...matchedTopicSlugs],
                tags,
                matchScore: m.score,
                matchedTerms: m.matched,
                generator: GENERATOR,
              }
              const before = (yield* cal.list({
                source: ["driver-events"],
                status: ["tentative", "confirmed", "cancelled"],
              })).find(
                (e) => e.externalId === ev.externalId,
              )
              const wasDismissed = before?.status === "cancelled"
              if (wasDismissed) {
                skippedDismissed += 1
                continue
              }
              const w = yield* cal.addSuggestion(inputForCal)
              written.push({
                slug: w.slug,
                relPath: w.relPath,
                title: ev.title,
                startsAt: ev.startsAt,
                score: m.score,
                matched: m.matched,
                upserted: before !== undefined,
              })
            }

            return {
              fetched: fetched.length,
              matched: matchedCount,
              written,
              skippedDismissed,
            }
          }),
      }
    }),
  )
