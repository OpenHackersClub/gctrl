import { Context, type Effect } from "effect"
import type { VaultError } from "../errors.js"
import type {
  EventKind,
  EventSource,
  EventStatus,
  ReminderEntry,
} from "../schemas.js"

export type EventLink = { readonly title: string; readonly url: string }

export type CalendarEvent = {
  readonly slug: string
  readonly title: string
  readonly kind: EventKind
  readonly source: EventSource
  readonly startsAt: string
  readonly endsAt: string | null
  readonly allDay: boolean
  readonly tz: string
  readonly status: EventStatus
  readonly location: string | null
  readonly tickers: ReadonlyArray<string>
  readonly topics: ReadonlyArray<string>
  readonly theses: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly links: ReadonlyArray<EventLink>
  readonly relatedPages: ReadonlyArray<string>
  readonly reminders: ReadonlyArray<ReminderEntry>
  readonly externalId: string | null
  readonly externalEtag: string | null
  readonly generator: string | null
  readonly contentHash: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  // Events-discovery extension (specs/events.md) — set by driver-events.
  readonly matchScore: number | null
  readonly matchedTerms: ReadonlyArray<string>
  readonly body: string
  readonly relPath: string
  readonly absPath: string
}

// Filter predicates from spec § Filtering & Views.
// Within a field, multi-value lists OR. Across fields, predicates AND.
// `from`/`to` are pre-resolved absolute ISO strings (caller resolves shortcuts via lib/calendar-filter).
export type EventFilter = {
  readonly source?: ReadonlyArray<EventSource>
  readonly kind?: ReadonlyArray<EventKind>
  readonly from?: string
  readonly to?: string
  readonly tickers?: ReadonlyArray<string>
  readonly topics?: ReadonlyArray<string>
  readonly theses?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  readonly status?: ReadonlyArray<EventStatus>
  readonly q?: string
}

// Inputs to add() — only what the user supplies; the adapter fills the rest
// (slug, source=user, status=confirmed, generator, hashes, timestamps).
export type EventAddInput = {
  readonly title: string
  readonly kind: EventKind
  readonly startsAt: string
  readonly endsAt?: string
  readonly allDay?: boolean
  readonly tz: string
  readonly status?: EventStatus
  readonly location?: string
  readonly tickers?: ReadonlyArray<string>
  readonly topics?: ReadonlyArray<string>
  readonly theses?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  readonly relatedPages?: ReadonlyArray<string>
  readonly body?: string
  // Caller may force a slug; otherwise derived from title + starts_at date.
  readonly slug?: string
}

// Inputs to addSuggestion() — driver-events-flavoured event written under
// calendar/suggested/. status starts as "tentative"; promote with accept().
export type SuggestionInput = {
  readonly title: string
  readonly startsAt: string
  readonly endsAt?: string
  readonly tz: string
  readonly location?: string
  readonly url?: string
  readonly description?: string
  readonly externalId: string
  readonly externalEtag?: string
  readonly topics?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  readonly matchScore: number
  readonly matchedTerms: ReadonlyArray<string>
  readonly generator: string
}

export type WrittenEvent = {
  readonly slug: string
  readonly absPath: string
  readonly relPath: string
  readonly contentHash: string
}

// Partial frontmatter overlay, used by future driver upserts. Body is preserved.
export type EventStamp = {
  readonly status?: EventStatus
  readonly externalEtag?: string
  readonly updatedAt?: string
  readonly contentHash?: string
}

// Outcome of accept/dismiss — `noop: true` means the event was already in the
// requested terminal state. Idempotency by design.
export type SuggestionDecision = {
  readonly slug: string
  readonly status: EventStatus
  readonly relPath: string
  readonly noop: boolean
}

export interface CalendarServiceShape {
  readonly list: (filter?: EventFilter) => Effect.Effect<ReadonlyArray<CalendarEvent>, VaultError>
  readonly get: (slug: string) => Effect.Effect<CalendarEvent, VaultError>
  readonly add: (input: EventAddInput) => Effect.Effect<WrittenEvent, VaultError>
  readonly stamp: (slug: string, stamp: EventStamp) => Effect.Effect<void, VaultError>
  // Driver-events writes a `status: tentative, source: driver-events` file under
  // calendar/suggested/. Re-calls with the same externalId are upserts.
  readonly addSuggestion: (input: SuggestionInput) => Effect.Effect<WrittenEvent, VaultError>
  // Promote a suggestion to a confirmed event (move out of suggested/).
  readonly accept: (slug: string) => Effect.Effect<SuggestionDecision, VaultError>
  // Mark a suggestion cancelled (kept in place for audit + dedupe).
  readonly dismiss: (slug: string) => Effect.Effect<SuggestionDecision, VaultError>
}

export class CalendarService extends Context.Tag("uebermensch/CalendarService")<
  CalendarService,
  CalendarServiceShape
>() {}
