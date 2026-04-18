import { Schema } from "effect"

/**
 * Frontmatter schemas for vault pages. Mirrors
 * apps/uebermensch/specs/knowledge-base.md § Frontmatter Schemas.
 *
 * Kept deliberately lax on optional fields — tests verify the hard contract,
 * not every shape detail the runtime KB writer will enforce later.
 */

const IsoLike = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/),
)

const Slug = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/))
const SourceSlug = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}--[a-z0-9][a-z0-9-]*$/),
)

const CommonBase = Schema.Struct({
  slug: Schema.Union(Slug, SourceSlug),
  title: Schema.String,
})

export const ThesisFrontmatter = Schema.Struct({
  page_type: Schema.Literal("thesis"),
  slug: Slug,
  title: Schema.String,
  topics: Schema.Array(Slug),
  stance: Schema.Literal("long", "short", "watch", "avoid"),
  conviction: Schema.Literal("high", "medium", "low"),
  opened_at: IsoLike,
  last_reviewed_at: IsoLike,
  disconfirming: Schema.Array(Schema.String).pipe(
    Schema.minItems(1),
    Schema.annotations({ message: () => "thesis must list ≥1 disconfirming condition" }),
  ),
})

export const EntityFrontmatter = Schema.Struct({
  page_type: Schema.Literal("entity"),
  slug: Slug,
  title: Schema.String,
  entity_role: Schema.Literal("company", "person", "org"),
})

export const TopicFrontmatter = Schema.Struct({
  page_type: Schema.Literal("topic"),
  slug: Slug,
  title: Schema.String,
  topic_role: Schema.Literal("sector", "macro", "market"),
})

export const SourceFrontmatter = Schema.Struct({
  page_type: Schema.Literal("source"),
  slug: SourceSlug,
  title: Schema.String,
  url: Schema.String.pipe(Schema.startsWith("http")),
  domain: Schema.String,
  published_at: IsoLike,
  fetched_at: IsoLike,
  topics: Schema.Array(Slug),
  entities: Schema.Array(Slug),
  content_hash: Schema.String,
})

export const BriefFrontmatter = Schema.Struct({
  page_type: Schema.Literal("brief"),
  slug: Schema.String,
  date: IsoLike,
  generator: Schema.String,
  topics_covered: Schema.Array(Slug),
})

export const ProfileConfig = Schema.Struct({
  schema_version: Schema.Number,
  identity: Schema.Struct({
    name: Schema.String,
    slug: Slug,
    tz: Schema.String,
    lang: Schema.String,
  }),
  budgets: Schema.Struct({
    daily_usd: Schema.Number.pipe(Schema.greaterThan(0)),
    per_brief_usd: Schema.Number.pipe(Schema.greaterThan(0)),
  }),
  delivery: Schema.Struct({
    brief: Schema.Struct({
      cron: Schema.String,
      format: Schema.Literal("long", "short", "digest"),
    }),
    channels: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
})

export const TopicsConfig = Schema.Struct({
  topics: Schema.Array(
    Schema.Struct({
      slug: Slug,
      title: Schema.String,
      horizon: Schema.Literal("short", "long", "both"),
      weight: Schema.Number,
    }),
  ).pipe(Schema.minItems(1)),
})

export const SourcesConfig = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      slug: Slug,
      driver: Schema.String,
      cadence: Schema.String,
      topics: Schema.Array(Slug),
    }),
  ).pipe(Schema.minItems(1)),
})
