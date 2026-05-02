import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Command } from "@effect/cli"
import { Console, Effect, Either, Layer } from "effect"
import { EnvSecretsLive } from "../adapters/EnvSecrets.js"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { StrictRendererLive } from "../adapters/StrictRenderer.js"
import { selectCandidates } from "../lib/candidates.js"
import { isChatChannel, resolveChannels } from "../lib/channels.js"
import { publicBaseUrl, publicBriefUrl, requiresR2Sync, resolveVaultDir } from "../lib/env.js"
import {
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_REPORTS_DIR,
  INPUT_WIKI_DIR,
} from "../lib/vault-paths.js"
import { DelivererService } from "../services/DelivererService.js"
import { LlmService } from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import { RendererService } from "../services/RendererService.js"
import { SyncService } from "../services/SyncService.js"
import { VaultService } from "../services/VaultService.js"

const today = () => new Date().toISOString().slice(0, 10)

const itemsForFormat = (format: "long" | "short" | "digest"): number => {
  switch (format) {
    case "long":
      return 12
    case "short":
      return 6
    case "digest":
      return 3
  }
}

// Generates today's brief if the file is absent, skips if already present.
// Returns the brief markdown content either way.
const runBriefGeneration = (
  date: string,
  vaultDir: string,
): Effect.Effect<string, unknown, ProfileService | VaultService | LlmService | RendererService> =>
  Effect.gen(function* () {
    const briefAbs = join(vaultDir, `${INPUT_BRIEFS_DIR}/${date}.md`)
    // ENOENT means "no brief yet, generate one" — must be a successful null,
    // NOT a failure. Effect.tryPromise's `catch` produces a failure value, so
    // an absent file was killing the pipeline with `error: null` (the morning
    // cron run-daily was hitting this every day the brief didn't pre-exist).
    const existing = yield* Effect.tryPromise(() => readFile(briefAbs, "utf8")).pipe(
      Effect.orElseSucceed(() => null as string | null),
    )
    if (existing !== null) {
      yield* Console.log(`brief already exists for ${date}, reusing`)
      return existing
    }

    yield* Console.log(`generating brief for ${date}`)
    const profileSvc = yield* ProfileService
    const vaultSvc = yield* VaultService
    const llm = yield* LlmService
    const renderer = yield* RendererService
    const profile = yield* profileSvc.load()

    const pages = yield* vaultSvc.recentlyChanged(24)
    yield* Console.log(`  ${pages.length} page(s) changed in last 24h`)

    const topicWeights = profile.topics.topics.map((t) => ({
      slug: t.slug,
      weight: t.weight,
    }))
    const candidates = selectCandidates({
      pages,
      topics: topicWeights,
      thesesSlugs: [],
      now: new Date(),
      windowHours: 24,
      maxCandidates: 40,
    })
    yield* Console.log(`  ${candidates.length} candidate(s) after ranking`)

    const maxItems = itemsForFormat(profile.profile.delivery.brief.format)
    const response = yield* llm.generateBrief({
      date,
      profileName: profile.profile.identity.name,
      topics: topicWeights.map((t) => t.slug),
      thesesSlugs: [],
      candidates,
      maxItems,
    })

    const vaultSlugs = yield* vaultSvc.listSlugs()
    const rendered = yield* renderer.render({
      date,
      generator: llm.name(),
      model: response.model,
      promptHash: response.promptHash,
      costUsd: response.costUsd,
      profileName: profile.profile.identity.name,
      topicsCovered: response.topicsCovered,
      thesesCovered: response.thesesCovered,
      candidates,
      items: response.items,
      vaultSlugs,
    })

    const written = yield* vaultSvc.writeBrief(date, rendered.markdown)
    yield* Console.log(
      `  wrote ${written.relPath} (${written.contentHash}) — ${rendered.citedClaims}/${rendered.totalClaims} claims cited`,
    )
    return rendered.markdown
  })

// Fans out the brief content to all configured channels.
// Returns { successes, failures } counts; never fails — errors are counted.
//
// Hosted-link invariant (specs/delivery.md): chat channels (telegram /
// discord) must link to a hosted URL (Cloudflare Pages, Tailscale Serve, or
// any HTTPS host). If any chat channel is enabled, require UBER_PUBLIC_BASE_URL.
// R2 sync runs only for the Cloudflare Pages backend; Tailscale / localhost /
// self-hosted setups serve the vault directly. The app driver is exempt and is
// delivered to even if the chat path is short-circuited.
const runSend = (
  date: string,
  vaultDir: string,
  content: string,
): Effect.Effect<
  { successes: number; failures: number },
  never,
  ProfileService | DelivererService | SyncService
> =>
  Effect.gen(function* () {
    const briefRel = `${INPUT_BRIEFS_DIR}/${date}.md`
    yield* Console.log(`sending ${briefRel} from ${vaultDir}`)

    const profileSvc = yield* ProfileService
    const deliverer = yield* DelivererService

    const loadResult = yield* profileSvc.load().pipe(Effect.either)
    if (Either.isLeft(loadResult)) {
      yield* Console.error(`  profile load failed: ${String(loadResult.left)}`)
      return { successes: 0, failures: 1 }
    }
    const loaded = loadResult.right

    const channelsResult = yield* resolveChannels(
      loaded.profile.delivery.channels as Record<string, unknown>,
      null,
    ).pipe(Effect.either)
    if (Either.isLeft(channelsResult)) {
      yield* Console.error(`  channel resolve failed: ${String(channelsResult.left)}`)
      return { successes: 0, failures: 1 }
    }
    const channels = channelsResult.right
    yield* Console.log(`  ${channels.length} channel(s) to deliver`)

    const briefUrl = publicBriefUrl(date)
    const chatChannels = channels.filter(isChatChannel)
    const appChannels = channels.filter((c) => !isChatChannel(c))

    let chatAllowed = true
    if (chatChannels.length > 0 && briefUrl === null) {
      yield* Console.error(
        "  UBER_PUBLIC_BASE_URL is not set — refusing to send brief to chat channels (telegram/discord) without a hosted link. Configure UBER_PUBLIC_BASE_URL=https://<host> (Cloudflare Pages, Tailscale Serve `https://<device>.<tailnet>.ts.net`, or any HTTPS host serving the vault) or remove chat channels from profile.",
      )
      chatAllowed = false
    }

    if (chatAllowed && chatChannels.length > 0 && requiresR2Sync(publicBaseUrl())) {
      yield* Console.log(`  syncing vault → R2 (briefs/reports/raw/wiki) ...`)
      const sync = yield* SyncService
      const syncResult = yield* sync
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
        .pipe(Effect.either)
      if (Either.isLeft(syncResult)) {
        const err = syncResult.left
        yield* Console.error(
          `  R2 sync failed (${err.kind}): ${err.message} — refusing to send chat messages whose hosted link would 404`,
        )
        chatAllowed = false
      } else {
        yield* Console.log(
          `    uploaded=${syncResult.right.uploaded} skipped=${syncResult.right.skipped} failed=${syncResult.right.failed}`,
        )
      }
    }

    let successes = 0
    let failures = 0
    const eligible = chatAllowed ? channels : appChannels
    if (eligible.length === 0 && channels.length > 0) {
      // All channels were chat and we short-circuited — count as failure so
      // run-daily exits non-zero and the scheduler retries / surfaces it.
      failures = chatChannels.length
    }
    for (const ch of eligible) {
      const deliveryContent = isChatChannel(ch)
        ? `${briefUrl}\n\n${content}`
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
            Console.log(`  ok ${r.channel} (${r.driver}) — ${r.parts} part(s)`),
          ),
          Effect.tapError((e) =>
            Console.log(`  fail ${ch.name} (${ch.driver}) — ${e.kind}: ${e.message}`),
          ),
          Effect.either,
        )
      Either.match(result, {
        onLeft: () => {
          failures++
        },
        onRight: () => {
          successes++
        },
      })
    }
    return { successes, failures }
  })

export const runDaily = Command.make("run-daily", {}, () =>
  Effect.gen(function* () {
    const vaultDir = yield* resolveVaultDir()
    const date = today()
    yield* Console.log(`uber run-daily ${date}`)

    const briefLayer = Layer.mergeAll(
      FileSystemProfileLive(vaultDir),
      FileSystemVaultLive(vaultDir),
      KernelLlmLive,
      StrictRendererLive,
    )

    const briefResult = yield* runBriefGeneration(date, vaultDir).pipe(
      Effect.provide(briefLayer),
      Effect.either,
    )

    if (Either.isLeft(briefResult)) {
      yield* Console.error(`brief generation failed: ${String(briefResult.left)}`)
      process.exit(1)
    }

    const briefContent = briefResult.right

    const syncLayer = R2SyncLive.pipe(Layer.provide(R2SyncConfigFromEnv))
    const { successes, failures } = yield* runSend(date, vaultDir, briefContent).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystemProfileLive(vaultDir),
          HttpDelivererLive,
          syncLayer,
        ),
      ),
      Effect.provide(EnvSecretsLive),
    )

    yield* Console.log(`delivery: ${successes} ok, ${failures} failed`)

    if (successes === 0 && failures === 0) {
      // No channels configured, or all kind=config — exit 2
      process.exit(2)
    }
    if (successes > 0 && failures > 0) {
      // Partial — exit 3; scheduler treats this as success
      process.exit(3)
    }
    if (successes === 0 && failures > 0) {
      // All deliveries failed
      process.exit(2)
    }
    // successes > 0 && failures === 0: exit 0 (default)
  }),
).pipe(Command.withDescription("Generate today's brief and fan out to all configured channels"))
