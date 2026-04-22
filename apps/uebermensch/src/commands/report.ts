import { Command, Options } from "@effect/cli"
import { Console, Effect, Layer, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { StrictRendererLive } from "../adapters/StrictRenderer.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { selectCandidates, type CandidateRef } from "../lib/candidates.js"
import { resolveChannels } from "../lib/channels.js"
import { publicReportUrl, resolveVaultDir } from "../lib/env.js"
import { DelivererService } from "../services/DelivererService.js"
import {
  LlmService,
  type InterestReportResponse,
  type ReportInterestInput,
} from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import {
  RendererService,
  type ReportIndexEntry,
} from "../services/RendererService.js"
import { SyncService } from "../services/SyncService.js"
import {
  VaultService,
  type ResearchInterest,
  type WikiPage,
} from "../services/VaultService.js"

const sinceDaysOpt = Options.integer("since-days").pipe(
  Options.withDescription("Lookback window in days (default 7)"),
  Options.withDefault(7),
)

const dateOpt = Options.text("date").pipe(
  Options.withDescription(
    "Anchor date (YYYY-MM-DD) used to derive the ISO week label; defaults to today",
  ),
  Options.optional,
)

const maxItemsOpt = Options.integer("max-items-per-interest").pipe(
  Options.withDescription("Cap evidence items per interest report"),
  Options.withDefault(5),
)

const concurrencyOpt = Options.integer("concurrency").pipe(
  Options.withDescription("Concurrent LLM calls across interests"),
  Options.withDefault(3),
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Do not write the report files or send; print to stdout"),
  Options.withDefault(false),
)

const sendOpt = Options.boolean("send").pipe(
  Options.withDescription(
    "After generating, deliver the index to enabled telegram/discord channels",
  ),
  Options.withDefault(false),
)

const syncOpt = Options.boolean("sync").pipe(
  Options.withDescription(
    "After writing, upload reports + briefs + wiki/sources to R2 (auto-on when --send and UBER_PUBLIC_BASE_URL are set)",
  ),
  Options.withDefault(false),
)

const llmOpt = Options.choice("llm", ["kernel", "stub"]).pipe(
  Options.withDescription(
    "LLM backend: 'kernel' (real Claude via kernel /api/llm/messages) or 'stub'",
  ),
  Options.withDefault("kernel" as const),
)

const today = () => new Date().toISOString().slice(0, 10)

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)

const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + n)
  return x
}

const toYmd = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`

// ISO 8601 week-numbering year + week
const isoWeekLabel = (d: Date): { year: number; week: number; label: string } => {
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  )
  const day = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return {
    year: target.getUTCFullYear(),
    week,
    label: `${target.getUTCFullYear()}-W${pad2(week)}`,
  }
}

const filterPagesForInterest = (
  pages: ReadonlyArray<WikiPage>,
  interest: ResearchInterest,
): ReadonlyArray<WikiPage> => {
  const topicSet = new Set(interest.topics)
  return pages.filter((p) => {
    const pageTopics = (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []
    return pageTopics.some((t) => topicSet.has(t))
  })
}

const weightedTopicsFor = (
  interest: ResearchInterest,
  profileTopics: ReadonlyArray<{ slug: string; weight: number }>,
): ReadonlyArray<{ slug: string; weight: number }> => {
  const interestSet = new Set(interest.topics)
  const boost = interest.weight ?? 1.0
  return profileTopics
    .filter((t) => interestSet.has(t.slug))
    .map((t) => ({ slug: t.slug, weight: t.weight * boost }))
}

// First paragraph of analysis_md (the Thesis section body), trimmed for index headlines.
const thesisHeadline = (analysis_md: string): string | null => {
  const trimmed = analysis_md.trim()
  if (trimmed.length === 0) return null
  const match = trimmed.match(/###\s+Thesis\s*\n+([\s\S]*?)(?=\n###\s|$)/)
  const block = (match ? match[1] : trimmed).trim()
  if (block.length === 0) return null
  const firstPara = block.split(/\n\s*\n/, 1)[0].trim()
  return firstPara.length > 0 ? firstPara : null
}

export const report = Command.make(
  "report",
  {
    sinceDaysOpt,
    dateOpt,
    maxItemsOpt,
    concurrencyOpt,
    dryRunOpt,
    sendOpt,
    syncOpt,
    llmOpt,
  },
  ({
    sinceDaysOpt: sinceDays,
    dateOpt: dateOptVal,
    maxItemsOpt: maxItems,
    concurrencyOpt: concurrency,
    dryRunOpt: dryRun,
    sendOpt: doSend,
    syncOpt: doSyncOpt,
    llmOpt: llmKind,
  }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const anchor = Option.getOrElse(dateOptVal, today)
      const anchorDate = new Date(`${anchor}T00:00:00Z`)
      const { label: periodLabel } = isoWeekLabel(anchorDate)
      const periodEnd = anchor
      const periodStart = toYmd(addDays(anchorDate, -sinceDays))
      yield* Console.log(
        `generating weekly reports ${periodLabel} (${periodStart} → ${periodEnd}) from ${vaultDir} (llm=${llmKind}, concurrency=${concurrency})`,
      )

      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const vaultSvc = yield* VaultService
        const llm = yield* LlmService
        const renderer = yield* RendererService
        const profile = yield* profileSvc.load()

        const interests = yield* vaultSvc.listResearchInterests()
        if (interests.length === 0) {
          yield* Console.log("  no research interests in research/ — nothing to report")
          return
        }
        yield* Console.log(`  ${interests.length} research interest(s) loaded`)

        // Cross-check interest topic/source slugs against profile (warn only).
        const topicSlugs = new Set(profile.topics.topics.map((t) => t.slug))
        const sourceSlugs = new Set(profile.sources.sources.map((s) => s.slug))
        for (const it of interests) {
          for (const t of it.topics) {
            if (!topicSlugs.has(t)) {
              yield* Console.log(
                `  ! research/${it.slug}: references unknown topic '${t}' (not in topics.md)`,
              )
            }
          }
          for (const s of it.sources) {
            if (!sourceSlugs.has(s)) {
              yield* Console.log(
                `  ! research/${it.slug}: references unknown source '${s}' (not in sources.md)`,
              )
            }
          }
        }

        const windowHours = sinceDays * 24
        const pages = yield* vaultSvc.recentlyChanged(windowHours)
        const profileTopicWeights = profile.topics.topics.map((t) => ({
          slug: t.slug,
          weight: t.weight,
        }))
        const now = new Date()

        const interestInputs: Array<
          ReportInterestInput & { readonly candidates: ReadonlyArray<CandidateRef> }
        > = interests.map((it) => {
          const scoped = filterPagesForInterest(pages, it)
          const weighted = weightedTopicsFor(it, profileTopicWeights)
          const cands = selectCandidates({
            pages: scoped,
            topics: weighted,
            thesesSlugs: [],
            now,
            windowHours,
            maxCandidates: 20,
          })
          return {
            slug: it.slug,
            title: it.title,
            question: it.question,
            topics: it.topics,
            notes: it.notes,
            candidates: cands,
          }
        })

        for (const ii of interestInputs) {
          yield* Console.log(`    ${ii.slug}: ${ii.candidates.length} candidate(s)`)
        }

        const vaultSlugs = yield* vaultSvc.listSlugs()

        // One LLM call per interest, run with bounded concurrency.
        const responses: ReadonlyArray<{
          readonly input: (typeof interestInputs)[number]
          readonly response: InterestReportResponse
        }> = yield* Effect.all(
          interestInputs.map((ii) =>
            Effect.gen(function* () {
              yield* Console.log(`  → ${ii.slug}: requesting deep analysis ...`)
              const response = yield* llm.generateInterestReport({
                periodLabel,
                periodStart,
                periodEnd,
                profileName: profile.profile.identity.name,
                interest: ii,
                maxItems,
              })
              return { input: ii, response }
            }),
          ),
          { concurrency },
        )

        // Render per-interest reports; drop empty ones (insight-only).
        type Written = {
          readonly interest: (typeof interestInputs)[number]
          readonly response: InterestReportResponse
          readonly markdown: string
          readonly reportSlug: string
          readonly relPath: string | null
          readonly itemCount: number
          readonly citedClaims: number
          readonly totalClaims: number
        }
        const written: Array<Written> = []
        let totalCost = 0
        for (const { input: ii, response } of responses) {
          totalCost += response.costUsd
          const analysisTrim = response.analysis_md.trim()
          if (analysisTrim.length === 0 && response.items.length === 0) {
            yield* Console.log(
              `  ${ii.slug}: empty (no substantive signal) — skipping write`,
            )
            continue
          }
          const rendered = yield* renderer.renderInterestReport({
            periodLabel,
            periodStart,
            periodEnd,
            generator: llm.name(),
            model: response.model,
            promptHash: response.promptHash,
            costUsd: response.costUsd,
            profileName: profile.profile.identity.name,
            interestSlug: ii.slug,
            interestTitle: ii.title,
            interestQuestion: ii.question,
            interestTopics: ii.topics,
            analysis_md: response.analysis_md,
            items: response.items,
            candidates: ii.candidates,
            vaultSlugs,
          })
          let relPath: string | null = null
          if (!dryRun) {
            const w = yield* vaultSvc.writeReport(rendered.slug, rendered.markdown)
            relPath = w.relPath
            yield* Console.log(
              `  ✓ ${w.relPath} (${w.contentHash}) — ${rendered.itemCount} item(s), ${rendered.citedClaims}/${rendered.totalClaims} claims cited`,
            )
          }
          written.push({
            interest: ii,
            response,
            markdown: rendered.markdown,
            reportSlug: rendered.slug,
            relPath,
            itemCount: rendered.itemCount,
            citedClaims: rendered.citedClaims,
            totalClaims: rendered.totalClaims,
          })
        }

        // Build the weekly index (one entry per surviving interest report).
        const entries: Array<ReportIndexEntry> = written.map((w) => ({
          interestSlug: w.interest.slug,
          interestTitle: w.interest.title,
          interestQuestion: w.interest.question,
          reportSlug: w.reportSlug,
          publicUrl: publicReportUrl(w.reportSlug),
          itemCount: w.itemCount,
          headline: thesisHeadline(w.response.analysis_md),
        }))
        const indexModel =
          written.length > 0 ? written[0].response.model : llm.name()
        const indexRendered = yield* renderer.renderReportIndex({
          periodLabel,
          periodStart,
          periodEnd,
          generator: llm.name(),
          model: indexModel,
          totalCostUsd: totalCost,
          profileName: profile.profile.identity.name,
          entries,
        })

        if (dryRun) {
          yield* Console.log("(dry-run — not writing)")
          yield* Console.log("")
          yield* Console.log(indexRendered.markdown)
          for (const w of written) {
            yield* Console.log("")
            yield* Console.log(`--- ${w.reportSlug} ---`)
            yield* Console.log(w.markdown)
          }
          return
        }

        const writtenIndex = yield* vaultSvc.writeReport(
          indexRendered.slug,
          indexRendered.markdown,
        )
        yield* Console.log(
          `✓ ${writtenIndex.relPath} (${writtenIndex.contentHash}) — ${indexRendered.interestCount} interest report(s), $${totalCost.toFixed(4)} total`,
        )

        const indexUrl = publicReportUrl(periodLabel)
        const doSync = doSyncOpt || (doSend && indexUrl !== null)
        if (doSync) {
          yield* Console.log(`syncing vault → R2 ...`)
          const syncResult = yield* Effect.serviceOption(SyncService).pipe(
            Effect.flatMap((maybe) =>
              Option.match(maybe, {
                onNone: () => Effect.succeed(null),
                onSome: (sync) =>
                  sync
                    .run({
                      vaultDir,
                      prefixes: ["reports", "briefs", "wiki/sources"],
                      dryRun: false,
                      force: false,
                    })
                    .pipe(
                      Effect.map((r) => r),
                      Effect.catchTag("SyncError", (e) =>
                        Console.log(`  ✗ sync failed (${e.kind}): ${e.message}`).pipe(
                          Effect.as(null),
                        ),
                      ),
                    ),
              }),
            ),
          )
          if (syncResult) {
            yield* Console.log(
              `  uploaded=${syncResult.uploaded} skipped=${syncResult.skipped} failed=${syncResult.failed}`,
            )
          }
        }

        if (!doSend) {
          yield* Console.log("")
          yield* Console.log(indexRendered.markdown)
          return
        }

        const deliveryContent = indexUrl
          ? `🌐 ${indexUrl}\n\n${indexRendered.markdown}`
          : indexRendered.markdown

        const deliverer = yield* DelivererService
        const channels = yield* resolveChannels(
          profile.profile.delivery.channels as Record<string, unknown>,
          null,
        )
        yield* Console.log(`  ${channels.length} channel(s) to deliver`)
        for (const ch of channels) {
          const result = yield* deliverer
            .send({
              channel: ch.name,
              driver: ch.driver,
              targetRef: ch.targetRef,
              silent: ch.silent,
              content: deliveryContent,
              briefDate: periodLabel,
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

      const llmLayer = llmKind === "stub" ? StubLlmLive : KernelLlmLive
      const syncLayer = R2SyncLive.pipe(Layer.provide(R2SyncConfigFromEnv))
      yield* program.pipe(
        Effect.provide(FileSystemProfileLive(vaultDir)),
        Effect.provide(FileSystemVaultLive(vaultDir)),
        Effect.provide(llmLayer),
        Effect.provide(StrictRendererLive),
        Effect.provide(HttpDelivererLive),
        Effect.provide(syncLayer),
      )
    }),
).pipe(
  Command.withDescription(
    "Generate deep weekly research reports (one file per interest) from research/ (optionally --send the index to channels)",
  ),
)
