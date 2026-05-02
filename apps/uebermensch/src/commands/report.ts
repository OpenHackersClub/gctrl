import { Command, Options } from "@effect/cli"
import { Console, Effect, Either, Layer, Option } from "effect"
import { EnvSecretsLive } from "../adapters/EnvSecrets.js"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { _internal as KernelLlmInternal, KernelLlmLive } from "../adapters/KernelLlm.js"
import { R2SyncConfigFromEnv, R2SyncLive } from "../adapters/R2Sync.js"
import { StrictRendererLive } from "../adapters/StrictRenderer.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { DeliveryError } from "../errors.js"
import { selectCandidates, type CandidateRef } from "../lib/candidates.js"
import { isChatChannel, resolveChannels } from "../lib/channels.js"
import { publicBaseUrl, publicReportUrl, requiresR2Sync, resolveVaultDir } from "../lib/env.js"
import {
  DIRECTIVES_RESEARCH_DIR,
  DIRECTIVES_SOURCES_FILE,
  DIRECTIVES_TOPICS_FILE,
  INPUT_BRIEFS_DIR,
  INPUT_RAW_DIR,
  INPUT_REPORTS_DIR,
  INPUT_WIKI_DIR,
} from "../lib/vault-paths.js"
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

// Sentinel for "operator did not pass --concurrency"; the model-aware
// default kicks in once we know which model is active. Negative because
// `Options.integer` allows 0 and any positive int as legitimate values.
const CONCURRENCY_UNSET = -1

const envConcurrency = (): number | null => {
  const raw = process.env.UBER_REPORT_CONCURRENCY
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Resolve the concurrency to use given the operator's flags + active model.
// Precedence: explicit `--concurrency` > `UBER_REPORT_CONCURRENCY` > per-model
// default (opus-4.7 → 1 to live within Anthropic tier-1 30k input TPM;
// opus-4.x → 2; sonnet → 4; haiku/local → 6/2).
const resolveConcurrency = (
  cliValue: number,
  activeModel: string | undefined,
): number => {
  if (cliValue !== CONCURRENCY_UNSET) return cliValue
  const fromEnv = envConcurrency()
  if (fromEnv !== null) return fromEnv
  return KernelLlmInternal.defaultConcurrencyForModel(activeModel)
}

const concurrencyOpt = Options.integer("concurrency").pipe(
  Options.withDescription(
    "Concurrent LLM calls across interests. Defaults to a model-aware value (opus-4.7 → 1, opus-4.x → 2, sonnet → 4, haiku/local → 6/2). Override with UBER_REPORT_CONCURRENCY or this flag.",
  ),
  Options.withDefault(CONCURRENCY_UNSET),
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
    "After writing, upload input/reports + input/briefs + input/raw + input/wiki to R2 (auto-on when --send and UBER_PUBLIC_BASE_URL are set)",
  ),
  Options.withDefault(false),
)

const llmOpt = Options.choice("llm", ["kernel", "stub"]).pipe(
  Options.withDescription(
    "LLM backend: 'kernel' (real Claude via kernel /api/llm/messages) or 'stub'",
  ),
  Options.withDefault("kernel" as const),
)

const modelOpt = Options.text("model").pipe(
  Options.withDescription(
    "LLM model id for this run (e.g. claude-opus-4-7, claude-sonnet-4-6, @cf/google/gemma-4-26b-a4b-it, google/gemma-4-31b). Sets UBER_LLM_MODEL for the process. Anthropic ids route through /api/llm/messages; everything else through /api/llm/completions.",
  ),
  Options.optional,
)

const effortOpt = Options.choice("effort", ["low", "medium", "high"]).pipe(
  Options.withDescription(
    "How much LLM effort to spend per stage. 'low' caps output tokens and disables thinking; 'medium' (default) is adaptive thinking with the standard token budget; 'high' enables extended thinking with a budget bump and doubles the output cap. Sets UBER_LLM_EFFORT for the process. Per-token billing is a kernel/driver-llm concern, not exposed here.",
  ),
  Options.optional,
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
// Matches any markdown heading level so occasional model drift (## / #### Thesis) still works.
const thesisHeadline = (analysis_md: string): string | null => {
  const trimmed = analysis_md.trim()
  if (trimmed.length === 0) return null
  const match = trimmed.match(/^#{2,4}\s+Thesis\s*\n+([\s\S]*?)(?=\n#{2,4}\s|$)/m)
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
    modelOpt,
    effortOpt,
  },
  ({
    sinceDaysOpt: sinceDays,
    dateOpt: dateOptVal,
    maxItemsOpt: maxItems,
    concurrencyOpt: concurrencyCli,
    dryRunOpt: dryRun,
    sendOpt: doSend,
    syncOpt: doSyncOpt,
    llmOpt: llmKind,
    modelOpt: modelOverride,
    effortOpt: effortOverride,
  }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      // Dynamic model selection: --model sets UBER_LLM_MODEL for this process so
      // KernelLlm.modelFor() picks it up across all three pipeline stages
      // (subtopic propose, deep-dive, summary).
      Option.match(modelOverride, {
        onNone: () => {},
        onSome: (m) => {
          process.env.UBER_LLM_MODEL = m
        },
      })
      Option.match(effortOverride, {
        onNone: () => {},
        onSome: (e) => {
          process.env.UBER_LLM_EFFORT = e
        },
      })
      const activeModelRaw =
        Option.getOrUndefined(modelOverride) ?? process.env.UBER_LLM_MODEL
      const activeModel = activeModelRaw ?? "(default)"
      const activeEffort =
        Option.getOrUndefined(effortOverride) ??
        process.env.UBER_LLM_EFFORT ??
        "medium"
      const concurrency = resolveConcurrency(concurrencyCli, activeModelRaw)
      const anchor = Option.getOrElse(dateOptVal, today)
      const anchorDate = new Date(`${anchor}T00:00:00Z`)
      const { label: periodLabel } = isoWeekLabel(anchorDate)
      const periodEnd = anchor
      const periodStart = toYmd(addDays(anchorDate, -sinceDays))
      yield* Console.log(
        `generating weekly reports ${periodLabel} (${periodStart} → ${periodEnd}) from ${vaultDir} (llm=${llmKind}, model=${activeModel}, effort=${activeEffort}, concurrency=${concurrency})`,
      )

      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const vaultSvc = yield* VaultService
        const llm = yield* LlmService
        const renderer = yield* RendererService
        const profile = yield* profileSvc.load()

        const interests = yield* vaultSvc.listResearchInterests()
        if (interests.length === 0) {
          yield* Console.log(
            `  no research interests in ${DIRECTIVES_RESEARCH_DIR}/ — nothing to report`,
          )
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
                `  ! ${DIRECTIVES_RESEARCH_DIR}/${it.slug}: references unknown topic '${t}' (not in ${DIRECTIVES_TOPICS_FILE})`,
              )
            }
          }
          for (const s of it.sources) {
            if (!sourceSlugs.has(s)) {
              yield* Console.log(
                `  ! ${DIRECTIVES_RESEARCH_DIR}/${it.slug}: references unknown source '${s}' (not in ${DIRECTIVES_SOURCES_FILE})`,
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
            fieldFamiliarity: it.fieldFamiliarity,
          }
        })

        for (const ii of interestInputs) {
          yield* Console.log(`    ${ii.slug}: ${ii.candidates.length} candidate(s)`)
        }

        const vaultSlugs = yield* vaultSvc.listSlugs()

        // Two-pass per interest: (1) propose sub-topic for the week, (2) deep-
        // dive on the chosen sub-topic with that subtopic's relevant candidates.
        type DeepResponse = {
          readonly input: (typeof interestInputs)[number]
          readonly subtopicSelected: {
            readonly slug: string
            readonly title: string
            readonly rationale: string
          } | null
          readonly subtopicAlternatives: ReadonlyArray<{
            readonly slug: string
            readonly title: string
            readonly rationale: string
          }>
          readonly proposeCostUsd: number
          readonly response: InterestReportResponse
        }
        const responses: ReadonlyArray<DeepResponse> = yield* Effect.all(
          interestInputs.map((ii) =>
            Effect.gen(function* () {
              yield* Console.log(`  → ${ii.slug}: proposing subtopic ...`)
              const propose = yield* llm.proposeSubtopic({
                periodLabel,
                periodStart,
                periodEnd,
                profileName: profile.profile.identity.name,
                interest: ii,
              })
              const selected = propose.proposals.find(
                (p) => p.slug === propose.selectedSlug,
              )
              const subtopicSelected = selected
                ? {
                    slug: selected.slug,
                    title: selected.title,
                    rationale: selected.rationale,
                  }
                : null
              const subtopicAlternatives = propose.proposals
                .filter((p) => p.slug !== propose.selectedSlug)
                .map((p) => ({
                  slug: p.slug,
                  title: p.title,
                  rationale: p.rationale,
                }))
              // Pass 2 always sees the full candidate pool (top up to 20):
              // the marked-relevant ones first, then the highest-scored
              // unmarked ones as adjacent context. A narrow subtopic with only
              // 1–2 marked candidates was starving pass 2 below the prompt's
              // 600-word floor; topping up gives the model enough material to
              // write a substantive deep-dive while the subtopic prompt keeps
              // the framing focused.
              const MIN_DEEP_CANDIDATES = 20
              const relevantSet = new Set(selected?.relevantCandidateIds ?? [])
              const marked = ii.candidates.filter((c) => relevantSet.has(c.id))
              const markedIds = new Set(marked.map((c) => c.id))
              const fillers = ii.candidates
                .filter((c) => !markedIds.has(c.id))
                .slice(0, Math.max(0, MIN_DEEP_CANDIDATES - marked.length))
              const filteredCands = [...marked, ...fillers]
              const interestForDeep: typeof ii = {
                ...ii,
                candidates: filteredCands,
              }
              yield* Console.log(
                subtopicSelected
                  ? `  → ${ii.slug}: deep-dive on subtopic '${subtopicSelected.title}' (${marked.length}/${ii.candidates.length} marked relevant)`
                  : `  → ${ii.slug}: deep-dive (no subtopic selected)`,
              )
              const response = yield* llm.generateInterestReport({
                periodLabel,
                periodStart,
                periodEnd,
                profileName: profile.profile.identity.name,
                interest: interestForDeep,
                maxItems,
                subtopic: subtopicSelected,
              })
              return {
                input: ii,
                subtopicSelected,
                subtopicAlternatives,
                proposeCostUsd: propose.costUsd,
                response,
              }
            }),
          ),
          { concurrency },
        )

        // Render per-interest reports; drop empty ones (insight-only).
        type Written = {
          readonly interest: (typeof interestInputs)[number]
          readonly subtopicSelected: DeepResponse["subtopicSelected"]
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
        for (const r of responses) {
          const ii = r.input
          const response = r.response
          // Total cost combines pass 1 (propose) and pass 2 (deep-dive).
          const interestCost = response.costUsd + r.proposeCostUsd
          totalCost += interestCost
          const analysisTrim = response.analysis_md.trim()
          if (analysisTrim.length === 0 && response.items.length === 0) {
            yield* Console.log(
              `  ${ii.slug}: empty (no substantive signal) — skipping write`,
            )
            continue
          }
          // Per-interest renderer failures (CitationError, IO) MUST NOT abort
          // the whole pipeline. A hallucinated wikilink in one report should
          // skip that interest, log the error, and let surviving reports +
          // the index still land. Wrapping in Effect.either turns the failure
          // into an Either we branch on rather than propagating it up.
          const renderEither = yield* renderer
            .renderInterestReport({
              periodLabel,
              periodStart,
              periodEnd,
              generator: llm.name(),
              model: response.model,
              promptHash: response.promptHash,
              costUsd: interestCost,
              profileName: profile.profile.identity.name,
              interestSlug: ii.slug,
              interestTitle: ii.title,
              interestQuestion: ii.question,
              interestTopics: ii.topics,
              fieldFamiliarity: ii.fieldFamiliarity,
              subtopic: r.subtopicSelected,
              subtopicAlternatives: r.subtopicAlternatives,
              analysis_md: response.analysis_md,
              items: response.items,
              candidates: ii.candidates,
              vaultSlugs,
            })
            .pipe(Effect.either)
          if (Either.isLeft(renderEither)) {
            const err = renderEither.left
            yield* Console.log(
              `  ✗ ${ii.slug}: render failed (${(err as { _tag?: string })._tag ?? "error"}): ${(err as { message?: string }).message ?? String(err)} — skipping`,
            )
            continue
          }
          const rendered = renderEither.right
          let relPath: string | null = null
          if (!dryRun) {
            const w = yield* vaultSvc.writeReport(rendered.slug, rendered.markdown)
            relPath = w.relPath
            yield* Console.log(
              `  ✓ ${w.relPath} (${w.contentHash}) — ${rendered.itemCount} item(s), ${rendered.citedClaims}/${rendered.totalClaims} claims cited`,
            )
            yield* Console.log(
              `    cost: $${interestCost.toFixed(4)} (propose=$${r.proposeCostUsd.toFixed(4)} deep=$${response.costUsd.toFixed(4)} in=${response.inputTokens}t out=${response.outputTokens}t model=${response.model})`,
            )
          }
          written.push({
            interest: ii,
            subtopicSelected: r.subtopicSelected,
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
          subtopicTitle: w.subtopicSelected?.title ?? null,
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

        // Hosted-link invariant (specs/delivery.md): if --send is requested
        // and any chat channel is enabled, UBER_PUBLIC_BASE_URL must be set
        // so chat messages can link to a hosted report (Cloudflare Pages,
        // Tailscale Serve, etc.). The strict channel check happens just
        // before the fan-out below; sync is scheduled up-front so chat
        // content is live before delivery. R2 sync only applies to the
        // Cloudflare Pages backend — Tailscale / localhost setups serve the
        // vault directly and skip the upload.
        const doSync = (doSyncOpt || doSend) && requiresR2Sync(publicBaseUrl())
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
                      prefixes: [
                        INPUT_REPORTS_DIR,
                        INPUT_BRIEFS_DIR,
                        INPUT_RAW_DIR,
                        INPUT_WIKI_DIR,
                      ],
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

        if (written.length === 0) {
          yield* Console.log(
            "  no interests produced substantive signal — skipping delivery",
          )
          return
        }

        const deliverer = yield* DelivererService
        const channels = yield* resolveChannels(
          profile.profile.delivery.channels as Record<string, unknown>,
          null,
        )
        yield* Console.log(`  ${channels.length} channel(s) to deliver`)

        // Hosted-link invariant: chat channels MUST link to a hosted URL
        // (Cloudflare Pages, Tailscale Serve, or any HTTPS host). If any chat
        // channel is enabled and UBER_PUBLIC_BASE_URL is unset, fail rather
        // than ship a chat message without a hosted link. App-driver channels
        // are exempt.
        const chatChannels = channels.filter(isChatChannel)
        if (chatChannels.length > 0 && indexUrl === null) {
          return yield* Effect.fail(
            new DeliveryError({
              message:
                "UBER_PUBLIC_BASE_URL is not set; refusing to send weekly report to chat channels (telegram/discord) without a hosted link. Set UBER_PUBLIC_BASE_URL=https://<host> (Cloudflare Pages, Tailscale Serve `https://<device>.<tailnet>.ts.net`, or any HTTPS host serving the vault) or drop --send.",
              kind: "config",
            }),
          )
        }

        for (const ch of channels) {
          const deliveryContent = isChatChannel(ch)
            ? `🌐 ${indexUrl}\n\n${indexRendered.markdown}`
            : indexRendered.markdown
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
        Effect.provide(EnvSecretsLive),
        Effect.provide(syncLayer),
      )
    }),
).pipe(
  Command.withDescription(
    "Generate deep weekly research reports (one file per interest) from directives/research/ (optionally --send the index to channels)",
  ),
)
