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
  city: Schema.optional(Slug),
  country: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Z]{2}$/))),
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

// Events discovery (specs/events.md). Optional — vaults without an `events:`
// block fall back to driver-disabled defaults.
export const EventsSourceConfig = Schema.Struct({
  driver: Schema.Literal("luma"),
  city: Schema.optional(Slug),
})

export const EventsConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  min_match_score: Schema.optional(
    Schema.Number.pipe(Schema.between(0, 1)),
  ),
  interests: Schema.optional(Schema.Array(Schema.String)),
  sources: Schema.optional(Schema.Array(EventsSourceConfig)),
})

export const ProfileConfig = Schema.Struct({
  schema_version: Schema.Number,
  identity: Identity,
  budgets: Budgets,
  delivery: Delivery,
  events: Schema.optional(EventsConfig),
})

// Person topics open up name/alias matching and feed discovery.
// `kind` defaults to "topic"; vault files written before this field landed
// continue to load.
export const TopicKind = Schema.Literal("topic", "person")
export type TopicKind = typeof TopicKind.Type

// Discovery config — currently only meaningful for person topics. When
// `google_news` is true, `gctrl uber ingest person` auto-builds a Google News
// RSS query from `title` (and optionally aliases) and ingests recent items.
// `feeds` is a list of pre-built RSS/Atom URLs (e.g. a personal blog feed,
// substack, or a curated YouTube interview channel).
export const TopicDiscovery = Schema.Struct({
  google_news: Schema.optional(Schema.Boolean),
  interviews: Schema.optional(Schema.Boolean),
  feeds: Schema.optional(Schema.Array(Schema.String)),
})
export type TopicDiscovery = typeof TopicDiscovery.Type

export const TopicEntry = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  horizon: Schema.Literal("short", "long", "both"),
  weight: Schema.Number,
  kind: Schema.optional(TopicKind),
  // Free-text surface forms used during classification: full name, handles,
  // common short forms. Unlike `watchlist` (which is slug-shaped), aliases
  // accept spaces, punctuation, and mixed case — "Sam Altman", "@sama".
  aliases: Schema.optional(Schema.Array(Schema.String)),
  watchlist: Schema.optional(Schema.Array(Slug)),
  discovery: Schema.optional(TopicDiscovery),
})

export const TopicsConfig = Schema.Struct({
  topics: Schema.Array(TopicEntry).pipe(Schema.minItems(1)),
})

export const SourceKind = Schema.Literal("news", "paper", "research-blog", "primary")

export const SourceEntry = Schema.Struct({
  slug: Slug,
  driver: Schema.String,
  cadence: Schema.String,
  topics: Schema.Array(Slug),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  // kind drives candidate ranking and renderer "Latest research" callout.
  // Defaults to "news" when omitted (see SourceEntryDefaults).
  kind: Schema.optional(SourceKind),
  config: Schema.optional(Schema.Unknown),
})

export const SourcesConfig = Schema.Struct({
  sources: Schema.Array(SourceEntry).pipe(Schema.minItems(1)),
})

export const FieldFamiliarity = Schema.Literal("expert", "novice")

export const ResearchInterestFrontmatter = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  question: Schema.optional(Schema.String),
  topics: Schema.Array(Slug).pipe(Schema.minItems(1)),
  sources: Schema.optional(Schema.Array(Slug)),
  horizon: Schema.optional(Schema.Literal("short", "long", "both")),
  weight: Schema.optional(Schema.Number),
  // expert = assume technical fluency; novice = ELI5 framing in deep-dives.
  // Defaults to "expert" when omitted.
  field_familiarity: Schema.optional(FieldFamiliarity),
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
  "practice",
  "other",
)
export type EventKind = typeof EventKind.Type

export const EventSource = Schema.Literal(
  "user",
  "driver-markets",
  "driver-sec",
  "driver-gcal",
  "driver-events",
  "import",
)
export type EventSource = typeof EventSource.Type

export const EventStatus = Schema.Literal(
  "confirmed",
  "tentative",
  "cancelled",
  "superseded",
)
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
  // Timebox child fields — present when this event belongs to a parent timebox.
  // Validation rule: if `timebox` is set, `step`/`step_total`/`step_units` MUST be set.
  // See vault/specs/calendar-timeboxes.md § Child Event Frontmatter Additions.
  timebox: Schema.optional(Slug),
  step: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))),
  step_total: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))),
  step_units: Schema.optional(Schema.String),
  // Events-discovery extension (specs/events.md). Optional, set by
  // driver-events; ignored by other sources.
  match_score: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
  matched_terms: Schema.optional(Schema.Array(Schema.String)),
})
export type EventFrontmatter = typeof EventFrontmatter.Type

// === Timebox (calendar-timeboxes.md) ===

// Open enum — the planner only needs `unit` + `session_minutes`; discipline drives
// display and downstream filtering. New values valid immediately, no migration.
export const Discipline = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]*$/))
export type Discipline = typeof Discipline.Type

export const TimeboxStatus = Schema.Literal("active", "paused", "done", "cancelled")
export type TimeboxStatus = typeof TimeboxStatus.Type

// `at` is a fraction in (0, 1] for progress-triggered nudges, or an ISO 8601
// date for absolute-time nudges. Validated as union of number-in-range or IsoLike.
export const TimeboxNudge = Schema.Struct({
  at: Schema.Union(
    Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1)),
    IsoLike,
  ),
  template: Schema.String,
})
export type TimeboxNudge = typeof TimeboxNudge.Type

export const TimeboxCoaching = Schema.Struct({
  nudges: Schema.optional(Schema.Array(TimeboxNudge)),
})

// Spec § Timebox Frontmatter — required: slug, kind, discipline, title, goal,
// deadline, unit, total, session_minutes, sessions_per_week, status,
// created_at, updated_at, content_hash. `done` is rolled up by `complete` and
// MUST NOT be set by hand (validation enforces 0 default at create time).
export const TimeboxFrontmatter = Schema.Struct({
  slug: Slug,
  kind: Schema.Literal("practice"),
  discipline: Discipline,
  title: Schema.String,
  goal: Schema.String,
  deadline: IsoLike,                              // ISO date or datetime
  unit: Schema.String.pipe(Schema.minLength(1)),  // pages | km | episodes | posts | ...
  total: Schema.Number.pipe(Schema.greaterThan(0)),
  done: Schema.optional(Schema.Number.pipe(Schema.greaterThanOrEqualTo(0))),
  session_minutes: Schema.Int.pipe(Schema.greaterThan(0)),
  sessions_per_week: Schema.Number.pipe(Schema.greaterThan(0)),
  status: TimeboxStatus,
  taper_days_before_deadline: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(0))),
  related_pages: Schema.optional(Schema.Array(Slug)),
  topics: Schema.optional(Schema.Array(Slug)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  coaching: Schema.optional(TimeboxCoaching),
  created_at: Schema.optional(IsoLike),
  updated_at: Schema.optional(IsoLike),
  content_hash: Schema.optional(Schema.String),
})
export type TimeboxFrontmatter = typeof TimeboxFrontmatter.Type

// Profile timebox config — see calendar-timeboxes.md § Profile Schema Additions.
// All fields optional in profile.md; defaults (60 min, 3/wk, P14D) are app-side.
export const TimeboxWorkingWindow = Schema.Struct({
  days: Schema.Array(Schema.Literal("mon", "tue", "wed", "thu", "fri", "sat", "sun")),
  start: Schema.String.pipe(Schema.pattern(/^\d{2}:\d{2}$/)),
  end: Schema.String.pipe(Schema.pattern(/^\d{2}:\d{2}$/)),
})
export type TimeboxWorkingWindow = typeof TimeboxWorkingWindow.Type

export const TimeboxProfileConfig = Schema.Struct({
  working_windows: Schema.optional(Schema.Array(TimeboxWorkingWindow)),
  default_session_minutes: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
  default_sessions_per_week: Schema.optional(Schema.Number.pipe(Schema.greaterThan(0))),
  stalled_threshold: Schema.optional(Schema.String),  // ISO 8601 duration
  replan_policy: Schema.optional(Schema.Literal("pin-edited", "redistribute-all")),
  coaching: Schema.optional(Schema.Struct({
    default_channel: Schema.optional(Schema.String),
  })),
})
export type TimeboxProfileConfig = typeof TimeboxProfileConfig.Type
