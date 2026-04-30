import { Context, type Effect } from "effect"
import type { ProfileError, VaultError } from "../errors.js"

export type SuggestPullInput = {
  // City slug used to pick the source URL. CLI flag wins; falls back to
  // profile.identity.city; fails if neither is set.
  readonly city?: string
  // Free-form interest strings; merged with profile.topics + events.interests.
  readonly interests?: ReadonlyArray<string>
  // Override profile.events.min_match_score for this run (0..1).
  readonly minMatchScore?: number
  // Cap candidates fetched from each source.
  readonly limit?: number
}

export type SuggestionWritten = {
  readonly slug: string
  readonly relPath: string
  readonly title: string
  readonly startsAt: string
  readonly score: number
  readonly matched: ReadonlyArray<string>
  readonly upserted: boolean
}

export type SuggestPullResult = {
  readonly fetched: number
  readonly matched: number
  readonly written: ReadonlyArray<SuggestionWritten>
  readonly skippedDismissed: number
}

export interface EventSuggesterServiceShape {
  readonly pull: (
    input: SuggestPullInput,
  ) => Effect.Effect<SuggestPullResult, VaultError | ProfileError>
}

export class EventSuggesterService extends Context.Tag(
  "uebermensch/EventSuggesterService",
)<EventSuggesterService, EventSuggesterServiceShape>() {}
