import { Command, Options } from "@effect/cli"
import { Console, Effect, Layer, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { HttpIngestDefaultConfig, HttpIngestLive } from "../adapters/HttpIngest.js"
import { resolveVaultDir } from "../lib/env.js"
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

export const ingest = Command.make("ingest").pipe(
  Command.withSubcommands([url]),
  Command.withDescription("Ingest external sources into the vault"),
)
