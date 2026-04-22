import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { resolveVaultDir } from "../lib/env.js"
import { SyncService } from "../services/SyncService.js"

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Show what would be uploaded without pushing"),
  Options.withDefault(false),
)

const forceOpt = Options.boolean("force").pipe(
  Options.withDescription("Ignore local sync manifest and re-upload everything"),
  Options.withDefault(false),
)

const prefixesOpt = Options.text("prefixes").pipe(
  Options.withDescription("Comma-separated vault subdirs to sync (default: reports,briefs,wiki/sources)"),
  Options.withDefault("reports,briefs,wiki/sources"),
)

const r2 = Command.make(
  "r2",
  { dryRunOpt, forceOpt, prefixesOpt },
  ({ dryRunOpt: dryRun, forceOpt: force, prefixesOpt: prefixesStr }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const prefixes = prefixesStr.split(",").map((s) => s.trim()).filter(Boolean)
      yield* Console.log(
        `syncing ${prefixes.join(", ")} from ${vaultDir} to R2 (dry-run=${dryRun})`,
      )
      const program = Effect.gen(function* () {
        const sync = yield* SyncService
        const result = yield* sync.run({ vaultDir, prefixes, dryRun, force })
        // Progress is logged inside the adapter; just print the summary line.
        yield* Console.log(
          `\ntotals: uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`,
        )
      })
      yield* program.pipe(
        Effect.provide(R2SyncLive),
        Effect.provide(R2SyncConfigFromEnv),
      )
    }),
).pipe(
  Command.withDescription(
    "Push reports/, briefs/, and wiki/sources/ to the R2 bucket (S3-compat; dedup via sha256 metadata)",
  ),
)

export const sync = Command.make("sync").pipe(
  Command.withSubcommands([r2]),
  Command.withDescription("Sync vault content to external storage"),
)
