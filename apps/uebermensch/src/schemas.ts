import { Schema } from "effect"

export const IsoLike = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/),
)

export const Slug = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/))

export const Window = Schema.Struct({
  start_local: Schema.String,
  end_local: Schema.String,
  tz: Schema.String,
})

export const Identity = Schema.Struct({
  name: Schema.String,
  slug: Slug,
  tz: Schema.String,
  lang: Schema.String,
})

export const Budgets = Schema.Struct({
  daily_usd: Schema.Number.pipe(Schema.greaterThan(0)),
  per_brief_usd: Schema.Number.pipe(Schema.greaterThan(0)),
  max_tokens_per_brief: Schema.optional(Schema.Number),
})

export const Channel = Schema.Struct({
  enabled: Schema.Boolean,
  driver: Schema.String,
  target_ref: Schema.String,
  window: Schema.optional(Window),
  silent: Schema.optional(Schema.Boolean),
})

export const Delivery = Schema.Struct({
  brief: Schema.Struct({
    cron: Schema.String,
    format: Schema.Literal("long", "short", "digest"),
  }),
  channels: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  personas: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  retention: Schema.optional(
    Schema.Struct({
      briefs_days: Schema.Number,
      alerts_days: Schema.Number,
    }),
  ),
})

export const ProfileConfig = Schema.Struct({
  schema_version: Schema.Number,
  identity: Identity,
  budgets: Budgets,
  delivery: Delivery,
})

export const TopicEntry = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  horizon: Schema.Literal("short", "long", "both"),
  weight: Schema.Number,
  watchlist: Schema.optional(Schema.Array(Slug)),
})

export const TopicsConfig = Schema.Struct({
  topics: Schema.Array(TopicEntry).pipe(Schema.minItems(1)),
})

export const SourceEntry = Schema.Struct({
  slug: Slug,
  driver: Schema.String,
  cadence: Schema.String,
  topics: Schema.Array(Slug),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  config: Schema.optional(Schema.Unknown),
})

export const SourcesConfig = Schema.Struct({
  sources: Schema.Array(SourceEntry).pipe(Schema.minItems(1)),
})

export const ResearchInterestFrontmatter = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  question: Schema.optional(Schema.String),
  topics: Schema.Array(Slug).pipe(Schema.minItems(1)),
  sources: Schema.optional(Schema.Array(Slug)),
  horizon: Schema.optional(Schema.Literal("short", "long", "both")),
  weight: Schema.optional(Schema.Number),
})

export const PromptStatus = Schema.Literal("pending", "processed", "failed", "rerun")

export const PromptFrontmatter = Schema.Struct({
  slug: Schema.optional(Slug),
  title: Schema.optional(Schema.String),
  topics: Schema.optional(Schema.Array(Slug)),
  status: Schema.optional(PromptStatus),
  output: Schema.optional(Schema.String),
  processed_at: Schema.optional(IsoLike),
  content_hash: Schema.optional(Schema.String),
  prompt_hash: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  cost_usd: Schema.optional(Schema.Number),
  failed_reason: Schema.optional(Schema.String),
})

// --- Calendar (specs/calendar.md) ---

export const EventKind = Schema.Literal(
  "personal",
  "deadline",
  "travel",
  "earnings",
  "macro",
  "regulatory",
  "corporate-action",
  "political",
  "prediction-market",
  "industry",
  "other",
)
export type EventKind = typeof EventKind.Type

export const EventSource = Schema.Literal(
  "user",
  "driver-markets",
  "driver-sec",
  "driver-gcal",
  "import",
)
export type EventSource = typeof EventSource.Type

export const EventStatus = Schema.Literal("confirmed", "tentative", "cancelled")
export type EventStatus = typeof EventStatus.Type

// Uppercase ticker per spec § Validation Rules #5
export const Ticker = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9.\-]{0,9}$/))

// ISO 8601 duration with leading sign (per spec § Validation Rules #9 — "-P1D", "-PT2H", "-PT15M")
export const ReminderOffset = Schema.String.pipe(
  Schema.pattern(/^-?P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/),
)

export const ReminderEntry = Schema.Struct({
  offset: ReminderOffset,
  channel: Schema.String,
})
export type ReminderEntry = typeof ReminderEntry.Type

export const EventLink = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
})

// Spec § Event Frontmatter — required: slug, title, kind, source, starts_at, tz, status.
// Everything else optional. Unknown fields are tolerated by the loader (forward-compat).
export const EventFrontmatter = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  kind: EventKind,
  source: EventSource,
  starts_at: IsoLike,
  ends_at: Schema.optional(IsoLike),
  all_day: Schema.optional(Schema.Boolean),
  tz: Schema.String,
  location: Schema.optional(Schema.String),
  tickers: Schema.optional(Schema.Array(Ticker)),
  topics: Schema.optional(Schema.Array(Slug)),
  theses: Schema.optional(Schema.Array(Slug)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  links: Schema.optional(Schema.Array(EventLink)),
  related_pages: Schema.optional(Schema.Array(Slug)),
  reminders: Schema.optional(Schema.Array(ReminderEntry)),
  external_id: Schema.optional(Schema.String),
  external_etag: Schema.optional(Schema.String),
  status: EventStatus,
  created_at: Schema.optional(IsoLike),
  updated_at: Schema.optional(IsoLike),
  generator: Schema.optional(Schema.String),
  content_hash: Schema.optional(Schema.String),
})
export type EventFrontmatter = typeof EventFrontmatter.Type
