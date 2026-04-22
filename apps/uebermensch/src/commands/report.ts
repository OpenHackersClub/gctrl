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
  type ReportInterestInput,
  type ReportSection,
} from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import {
  RendererService,
  type ReportSectionInput,
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
  Options.withDescription("Cap items per research interest section"),
  Options.withDefault(5),
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Do not write the report file or send; print to stdout"),
  Options.withDefault(false),
)

const sendOpt = Options.boolean("send").pipe(
  Options.withDescription("After generating, deliver to enabled telegram/discord channels"),
  Options.withDefault(false),
)

const syncOpt = Options.boolean("sync").pipe(
  Options.withDescription(
    "After writing, upload report + briefs + wiki/sources to R2 (auto-on when --send and UBER_PUBLIC_BASE_URL are set)",
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

export const report = Command.make(
  "report",
  { sinceDaysOpt, dateOpt, maxItemsOpt, dryRunOpt, sendOpt, syncOpt, llmOpt },
  ({
    sinceDaysOpt: sinceDays,
    dateOpt: dateOptVal,
    maxItemsOpt: maxItems,
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
        `generating weekly report ${periodLabel} (${periodStart} → ${periodEnd}) from ${vaultDir} (llm=${llmKind})`,
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
          yield* Console.log(
            `    ${ii.slug}: ${ii.candidates.length} candidate(s)`,
          )
        }

        const response = yield* llm.generateReport({
          periodLabel,
          periodStart,
          periodEnd,
          profileName: profile.profile.identity.name,
          interests: interestInputs,
          maxItemsPerInterest: maxItems,
        })

        // Merge by slug so renderer has access to candidates per section.
        const sectionBySlug = new Map<string, ReportSection>()
        for (const s of response.sections) sectionBySlug.set(s.interestSlug, s)

        const rendererSections: Array<ReportSectionInput> = interestInputs
          .map((ii) => {
            const s = sectionBySlug.get(ii.slug)
            return {
              interestSlug: ii.slug,
              interestTitle: ii.title,
              interestQuestion: ii.question,
              summary_md: s?.summary_md?.trim() ?? "",
              items: s?.items ?? [],
              candidates: ii.candidates,
            }
          })
          // Insight-only: drop sections the LLM chose to leave empty.
          .filter((s) => s.summary_md.length > 0 || s.items.length > 0)

        const vaultSlugs = yield* vaultSvc.listSlugs()
        const rendered = yield* renderer.renderReport({
          periodLabel,
          periodStart,
          periodEnd,
          generator: llm.name(),
          model: response.model,
          promptHash: response.promptHash,
          costUsd: response.costUsd,
          profileName: profile.profile.identity.name,
          sections: rendererSections,
          vaultSlugs,
        })

        if (dryRun) {
          yield* Console.log("(dry-run — not writing)")
          yield* Console.log("")
          yield* Console.log(rendered.markdown)
          return
        }

        const written = yield* vaultSvc.writeReport(periodLabel, rendered.markdown)
        yield* Console.log(
          `✓ wrote ${written.relPath} (${written.contentHash}) — ${rendered.sectionCount} section(s), ${rendered.itemCount} item(s), ${rendered.citedClaims}/${rendered.totalClaims} claims cited`,
        )

        const reportUrl = publicReportUrl(periodLabel)
        // Auto-sync when sending, so the URL in the delivered message resolves.
        const doSync = doSyncOpt || (doSend && reportUrl !== null)
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
          yield* Console.log(rendered.markdown)
          return
        }

        const deliveryContent = reportUrl
          ? `🌐 ${reportUrl}\n\n${rendered.markdown}`
          : rendered.markdown

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
    "Generate a weekly research report from research/ interests (optionally --send to channels)",
  ),
)
