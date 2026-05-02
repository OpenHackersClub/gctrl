import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Command, Options } from "@effect/cli"
import { Console, Effect, Layer, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { DeliveryError, VaultError } from "../errors.js"
import { isChatChannel, resolveChannels } from "../lib/channels.js"
import { publicBaseUrl, publicBriefUrl, requiresR2Sync, resolveVaultDir } from "../lib/env.js"
import {
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_REPORTS_DIR,
  INPUT_WIKI_DIR,
} from "../lib/vault-paths.js"
import { DelivererService } from "../services/DelivererService.js"
import { ProfileService } from "../services/ProfileService.js"
import { SyncService } from "../services/SyncService.js"

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

        // Hosted-link invariant (specs/delivery.md): chat channels must link
        // to a hosted URL (Cloudflare Pages, Tailscale Serve, or any HTTPS
        // host). UBER_PUBLIC_BASE_URL is required for chat fan-out. The app
        // driver is exempt — it renders the brief in-app from the vault.
        const briefUrl = publicBriefUrl(date)
        const chatChannels = channels.filter(isChatChannel)
        if (chatChannels.length > 0 && briefUrl === null) {
          return yield* Effect.fail(
            new DeliveryError({
              message:
                "UBER_PUBLIC_BASE_URL is not set; refusing to send brief to chat channels (telegram/discord) without a hosted link. Set UBER_PUBLIC_BASE_URL=https://<host> (Cloudflare Pages, Tailscale Serve `https://<device>.<tailnet>.ts.net`, or any HTTPS host serving the vault) or restrict to --channel <app-channel>.",
              kind: "config",
            }),
          )
        }

        // R2 sync only applies to the Cloudflare Pages backend. Tailscale-
        // served / localhost / self-hosted setups serve the vault directly.
        if (chatChannels.length > 0 && requiresR2Sync(publicBaseUrl())) {
          yield* Console.log(`syncing vault → R2 (briefs/reports/raw/wiki) ...`)
          const sync = yield* SyncService
          const result = yield* sync
            .run({
              vaultDir,
              prefixes: [
                INPUT_BRIEFS_DIR,
                INPUT_REPORTS_DIR,
                INPUT_RAW_DIR,
                INPUT_WIKI_DIR,
              ],
              dryRun: false,
              force: false,
            })
            .pipe(
              Effect.mapError(
                (e) =>
                  new DeliveryError({
                    message: `R2 sync failed before chat send (${e.kind}): ${e.message}; refusing to send chat messages whose hosted link would 404.`,
                    kind: "unreachable",
                  }),
              ),
            )
          yield* Console.log(
            `  uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`,
          )
        }

        for (const ch of channels) {
          const deliveryContent = isChatChannel(ch)
            ? `🌐 ${briefUrl}\n\n${content}`
            : content
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

      const syncLayer = R2SyncLive.pipe(Layer.provide(R2SyncConfigFromEnv))
      yield* program.pipe(
        Effect.provide(FileSystemProfileLive(vaultDir)),
        Effect.provide(HttpDelivererLive),
        Effect.provide(syncLayer),
      )
    }),
).pipe(
  Command.withDescription("Send a generated brief to configured channels (telegram, discord, app)"),
)
