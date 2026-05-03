import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { resolveVaultDir } from "../lib/env.js"
import {
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_REPORTS_DIR,
  INPUT_WIKI_DIR,
} from "../lib/vault-paths.js"
import { SyncService } from "../services/SyncService.js"

const DEFAULT_SYNC_PREFIXES = [
  INPUT_REPORTS_DIR,
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_WIKI_DIR,
] as const

const DEFAULT_SYNC_PREFIXES_STR = DEFAULT_SYNC_PREFIXES.join(",")

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Show what would be uploaded without pushing"),
  Options.withDefault(false),
)

const forceOpt = Options.boolean("force").pipe(
  Options.withDescription("Ignore the kernel's dedup manifest and re-upload everything"),
  Options.withDefault(false),
)

const prefixesOpt = Options.text("prefixes").pipe(
  Options.withDescription(
    `Comma-separated vault subdirs to sync (default: ${DEFAULT_SYNC_PREFIXES_STR})`,
  ),
  Options.withDefault(DEFAULT_SYNC_PREFIXES_STR),
)

const push = Command.make(
  "push",
  { dryRunOpt, forceOpt, prefixesOpt },
  ({ dryRunOpt: dryRun, forceOpt: force, prefixesOpt: prefixesStr }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const prefixes = prefixesStr.split(",").map((s) => s.trim()).filter(Boolean)
      yield* Console.log(
        `pushing ${prefixes.join(", ")} via kernel /api/sync/vault/push (dry-run=${dryRun})`,
      )
      const program = Effect.gen(function* () {
        const sync = yield* SyncService
        const result = yield* sync.run({ vaultDir, prefixes, dryRun, force })
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
    "Push input/reports/, input/briefs/, input/raw/, and input/wiki/ to R2 via the kernel's vault sync route (dedup is kernel-owned)",
  ),
)

export const sync = Command.make("sync").pipe(
  Command.withSubcommands([push]),
  Command.withDescription("Sync vault content to external storage via the gctrl kernel"),
)
