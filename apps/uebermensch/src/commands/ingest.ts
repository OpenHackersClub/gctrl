import { Command, Options } from "@effect/cli"
import { Console, Effect, Either, Layer, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { HttpFeedDefaultConfig, HttpFeedLive } from "../adapters/HttpFeed.js"
import { HttpIngestDefaultConfig, HttpIngestLive } from "../adapters/HttpIngest.js"
import { resolveVaultDir } from "../lib/env.js"
import { FeedService } from "../services/FeedService.js"
import { IngestService } from "../services/IngestService.js"
import { ProfileService } from "../services/ProfileService.js"

const urlOpt = Options.text("url").pipe(
  Options.withDescription("URL to fetch and store under wiki/sources/"),
)

const dateOpt = Options.text("date").pipe(
  Options.withDescription("Override fetched_at date (YYYY-MM-DD); defaults to today"),
  Options.optional,
)

const minWordsOpt = Options.integer("min-words").pipe(
  Options.withDescription("Reject pages with fewer words than this (default 50)"),
  Options.withDefault(50),
)

const overwriteOpt = Options.boolean("overwrite").pipe(
  Options.withDescription("Overwrite an existing wiki/sources/<slug>.md"),
  Options.withDefault(false),
)

const today = () => new Date().toISOString().slice(0, 10)

const url = Command.make(
  "url",
  { urlOpt, dateOpt, minWordsOpt, overwriteOpt },
  ({ urlOpt: u, dateOpt: dateOptVal, minWordsOpt: minWords, overwriteOpt: overwrite }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const date = Option.getOrElse(dateOptVal, today)

      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const ingest = yield* IngestService
        const profile = yield* profileSvc.load()
        const topicSlugs = profile.topics.topics.map((t) => t.slug)

        yield* Console.log(`ingesting ${u} into ${vaultDir} (date=${date})`)

        const result = yield* ingest.ingestUrl({
          url: u,
          date,
          topicSlugs,
          minWordCount: minWords,
          overwrite,
        })

        yield* Console.log(
          `✓ wrote ${result.relPath} — ${result.wordCount} words, topics=[${result.topicsMatched.join(", ")}]`,
        )
        yield* Console.log(`  content_hash: ${result.contentHash}`)
      })

      const vaultLayer = FileSystemVaultLive(vaultDir)
      const ingestLayer = HttpIngestLive.pipe(
        Layer.provide(Layer.mergeAll(vaultLayer, HttpIngestDefaultConfig)),
      )
      yield* program.pipe(
        Effect.provide(
          Layer.mergeAll(FileSystemProfileLive(vaultDir), vaultLayer, ingestLayer),
        ),
      )
    }),
).pipe(Command.withDescription("Fetch a URL and write wiki/sources/<date>--<domain>.md"))

const driverOpt = Options.text("driver").pipe(
  Options.withDescription("Only ingest sources with this driver (default: rss)"),
  Options.withDefault("rss"),
)

const sinceHoursOpt = Options.integer("since-hours").pipe(
  Options.withDescription("Only ingest feed items published within the last N hours"),
  Options.withDefault(168), // 7 days
)

const sourceSlugOpt = Options.text("source").pipe(
  Options.withDescription("Restrict to a single source slug from sources.md"),
  Options.optional,
)

const perFeedLimitOpt = Options.integer("limit").pipe(
  Options.withDescription("Max items to ingest per feed"),
  Options.withDefault(10),
)

const sourcesMinWordsOpt = Options.integer("min-words").pipe(
  Options.withDescription("Reject ingested pages with fewer words (default 50)"),
  Options.withDefault(50),
)

const sourcesOverwriteOpt = Options.boolean("overwrite").pipe(
  Options.withDescription("Overwrite existing pages (default: skip on collision)"),
  Options.withDefault(false),
)

const sourcesDryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Show what would be ingested without writing"),
  Options.withDefault(false),
)

const sources = Command.make(
  "sources",
  {
    driverOpt,
    sinceHoursOpt,
    sourceSlugOpt,
    perFeedLimitOpt,
    sourcesMinWordsOpt,
    sourcesOverwriteOpt,
    sourcesDryRunOpt,
  },
  ({
    driverOpt: driver,
    sinceHoursOpt: sinceHours,
    sourceSlugOpt: onlySlugVal,
    perFeedLimitOpt: limit,
    sourcesMinWordsOpt: minWords,
    sourcesOverwriteOpt: overwrite,
    sourcesDryRunOpt: dryRun,
  }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const onlySlug = Option.getOrNull(onlySlugVal)
      const now = new Date()
      const cutoff = new Date(now.getTime() - sinceHours * 3_600_000)
      const date = now.toISOString().slice(0, 10)

      yield* Console.log(
        `ingesting sources from ${vaultDir} (driver=${driver}, since ${cutoff.toISOString()})`,
      )

      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const feedSvc = yield* FeedService
        const ingestSvc = yield* IngestService
        const profile = yield* profileSvc.load()

        const allTopicSlugs = profile.topics.topics.map((t) => t.slug)
        const topicWatchlists: Record<string, ReadonlyArray<string>> = {}
        for (const t of profile.topics.topics) {
          topicWatchlists[t.slug] = t.watchlist ?? []
        }
        const selected = profile.sources.sources.filter((s) => {
          if (onlySlug !== null) return s.slug === onlySlug
          return s.driver === driver
        })
        if (selected.length === 0) {
          yield* Console.log(
            onlySlug !== null
              ? `  no source with slug "${onlySlug}"`
              : `  no sources with driver=${driver}`,
          )
          return
        }
        yield* Console.log(`  ${selected.length} source(s) selected`)

        let totalFetched = 0
        let totalIngested = 0
        let totalSkipped = 0
        let totalFailed = 0

        for (const src of selected) {
          if (!src.url) {
            yield* Console.log(`  - ${src.slug}: no url (driver=${src.driver}), skipping`)
            continue
          }
          const fetched = yield* feedSvc.fetchFeed(src.url).pipe(
            Effect.tap((f) =>
              Console.log(`  - ${src.slug}: ${f.format} "${f.title}" — ${f.items.length} item(s)`),
            ),
            Effect.tapError((e) =>
              Console.log(`  - ${src.slug}: feed fetch failed — ${e.kind}: ${e.message}`),
            ),
            Effect.either,
          )
          const feed = Either.getOrNull(fetched)
          if (feed === null) {
            totalFailed += 1
            continue
          }
          const windowItems = feed.items.filter((it) => {
            if (!it.link) return false
            if (!it.publishedAt) return true // include undated items
            return it.publishedAt >= cutoff
          })
          const batch = windowItems.slice(0, limit)
          totalFetched += batch.length
          yield* Console.log(
            `    ${batch.length}/${windowItems.length} within window (limit=${limit})`,
          )
          for (const item of batch) {
            if (dryRun) {
              yield* Console.log(`    [dry-run] ${item.link}`)
              continue
            }
            const result = yield* ingestSvc
              .ingestUrl({
                url: item.link,
                date,
                topicSlugs: allTopicSlugs,
                minWordCount: minWords,
                overwrite,
                forceTopics: src.topics,
                topicWatchlists,
                descriptionFromFeed: item.description ?? undefined,
              })
              .pipe(
                Effect.tap((r) =>
                  Console.log(
                    `    ✓ ${r.relPath} (${r.wordCount}w${r.paywalled ? ", paywalled" : ""}${r.bodySource === "rss_description" ? ", rss-desc" : ""}, topics=[${r.topicsMatched.join(", ")}])`,
                  ),
                ),
                Effect.tapError((e) =>
                  Console.log(`    ✗ ${item.link} — ${e.kind}: ${e.message}`),
                ),
                Effect.either,
              )
            Either.match(result, {
              onLeft: (e) => {
                if (e.kind === "collision") totalSkipped += 1
                else totalFailed += 1
              },
              onRight: () => {
                totalIngested += 1
              },
            })
          }
        }
        yield* Console.log(
          `\ntotals: fetched=${totalFetched} ingested=${totalIngested} skipped=${totalSkipped} failed=${totalFailed}`,
        )
      })

      const vaultLayer = FileSystemVaultLive(vaultDir)
      const ingestLayer = HttpIngestLive.pipe(
        Layer.provide(Layer.mergeAll(vaultLayer, HttpIngestDefaultConfig)),
      )
      const feedLayer = HttpFeedLive.pipe(Layer.provide(HttpFeedDefaultConfig))
      yield* program.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystemProfileLive(vaultDir),
            vaultLayer,
            ingestLayer,
            feedLayer,
          ),
        ),
      )
    }),
).pipe(
  Command.withDescription(
    "Walk sources.md, fetch each feed, and ingest recent items through the source pipeline",
  ),
)

export const ingest = Command.make("ingest").pipe(
  Command.withSubcommands([url, sources]),
  Command.withDescription("Ingest external sources into the vault"),
)
