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
