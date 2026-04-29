import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { VaultError } from "../errors.js"
import { resolveChannels } from "../lib/channels.js"
import { publicBriefUrl, resolveVaultDir } from "../lib/env.js"
import { INPUT_BRIEFS_DIR } from "../lib/vault-paths.js"
import { DelivererService } from "../services/DelivererService.js"
import { ProfileService } from "../services/ProfileService.js"

const dateOpt = Options.text("date").pipe(
  Options.withDescription("Brief date (YYYY-MM-DD); defaults to today"),
  Options.optional,
)

const channelOpt = Options.text("channel").pipe(
  Options.withDescription("Send to a specific channel name (bypasses enabled flag)"),
  Options.optional,
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Resolve channels + preview payload; skip HTTP"),
  Options.withDefault(false),
)

const today = () => new Date().toISOString().slice(0, 10)

export const send = Command.make(
  "send",
  { dateOpt, channelOpt, dryRunOpt },
  ({ dateOpt: dateOptVal, channelOpt: channelOptVal, dryRunOpt: dryRun }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const date = Option.getOrElse(dateOptVal, today)
      const only = Option.getOrNull(channelOptVal)
      const briefRel = `${INPUT_BRIEFS_DIR}/${date}.md`
      const briefAbs = join(vaultDir, briefRel)
      const content = yield* Effect.tryPromise({
        try: () => readFile(briefAbs, "utf8"),
        catch: () =>
          new VaultError({
            message: `brief not found: ${briefRel} (run \`uber brief --date ${date}\` first)`,
            path: briefAbs,
            kind: "not_found",
          }),
      })

      yield* Console.log(`sending ${briefRel} from ${vaultDir}`)

      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const deliverer = yield* DelivererService
        const loaded = yield* profileSvc.load()
        const channels = yield* resolveChannels(
          loaded.profile.delivery.channels as Record<string, unknown>,
          only,
        )
        yield* Console.log(`  ${channels.length} channel(s) to deliver`)

        if (dryRun) {
          for (const ch of channels) {
            yield* Console.log(
              `  [dry-run] ${ch.name} (driver=${ch.driver}, target=${ch.targetRef}, silent=${ch.silent})`,
            )
          }
          return
        }

        const briefUrl = publicBriefUrl(date)
        const deliveryContent = briefUrl ? `🌐 ${briefUrl}\n\n${content}` : content
        for (const ch of channels) {
          const result = yield* deliverer
            .send({
              channel: ch.name,
              driver: ch.driver,
              targetRef: ch.targetRef,
              silent: ch.silent,
              content: deliveryContent,
              briefDate: date,
            })
            .pipe(
              Effect.tap((r) =>
                Console.log(
                  `  ✓ ${r.channel} (${r.driver}) — ${r.parts} part(s)${r.externalIds.length > 0 ? ` ids=${r.externalIds.join(",")}` : ""}`,
                ),
              ),
              Effect.tapError((e) =>
                Console.log(`  ✗ ${ch.name} (${ch.driver}) — ${e.kind}: ${e.message}`),
              ),
              Effect.either,
            )
          void result
        }
      })

      yield* program.pipe(
        Effect.provide(FileSystemProfileLive(vaultDir)),
        Effect.provide(HttpDelivererLive),
      )
    }),
).pipe(
  Command.withDescription("Send a generated brief to configured channels (telegram, discord, app)"),
)
