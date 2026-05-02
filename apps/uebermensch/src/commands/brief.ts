import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { EnvSecretsLive } from "../adapters/EnvSecrets.js"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { StrictRendererLive } from "../adapters/StrictRenderer.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { buildLlmLayer } from "../lib/build-mode-layer.js"
import { selectCandidates } from "../lib/candidates.js"
import { resolveVaultDir } from "../lib/env.js"
import { resolveMode } from "../lib/mode.js"
import { LlmService } from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import { RendererService } from "../services/RendererService.js"
import { VaultService } from "../services/VaultService.js"

const sinceHoursOpt = Options.integer("since-hours").pipe(
  Options.withDescription("Window of recently-changed pages to feed the LLM"),
  Options.withDefault(24),
)

const dateOpt = Options.text("date").pipe(
  Options.withDescription("Brief date (YYYY-MM-DD); defaults to today"),
  Options.optional,
)

const maxItemsOpt = Options.integer("max-items").pipe(
  Options.withDescription("Maximum brief items (overrides profile brief format)"),
  Options.optional,
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Do not write the brief file; print to stdout only"),
  Options.withDefault(false),
)

const llmOpt = Options.choice("llm", ["kernel", "stub"]).pipe(
  Options.withDescription(
    "LLM backend: 'kernel' (real Claude via kernel /api/llm/messages) or 'stub'",
  ),
  Options.withDefault("kernel" as const),
)

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

type BriefProgramArgs = {
  readonly date: string
  readonly sinceHours: number
  readonly maxItemsOpt: Option.Option<number>
  readonly dryRun: boolean
}

/** Core brief-generation Effect — requires ProfileService, VaultService,
 *  LlmService, RendererService. Exported so tests can exercise it directly
 *  without spawning a CLI process. */
export const makeBriefProgram = ({ date, sinceHours, maxItemsOpt: maxItemsOptVal, dryRun }: BriefProgramArgs) =>
  Effect.gen(function* () {
    const profileSvc = yield* ProfileService
    const vaultSvc = yield* VaultService
    const llm = yield* LlmService
    const renderer = yield* RendererService
    const profile = yield* profileSvc.load()

    const pages = yield* vaultSvc.recentlyChanged(sinceHours)
    yield* Console.log(`  ${pages.length} page(s) changed in last ${sinceHours}h`)

    const topicWeights = profile.topics.topics.map((t) => ({
      slug: t.slug,
      weight: t.weight,
    }))
    const now = new Date()
    const candidates = selectCandidates({
      pages,
      topics: topicWeights,
      thesesSlugs: [],
      now,
      windowHours: sinceHours,
      maxCandidates: 40,
    })
    yield* Console.log(`  ${candidates.length} candidate(s) after ranking`)

    const maxItems = Option.getOrElse(maxItemsOptVal, () =>
      itemsForFormat(profile.profile.delivery.brief.format),
    )

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

    if (dryRun) {
      yield* Console.log("(dry-run — not writing)")
      yield* Console.log("")
      yield* Console.log(rendered.markdown)
      return
    }

    const written = yield* vaultSvc.writeBrief(date, rendered.markdown)
    yield* Console.log(
      `✓ wrote ${written.relPath} (${written.contentHash}) — ${rendered.citedClaims}/${rendered.totalClaims} claims cited`,
    )

    yield* Console.log("")
    yield* Console.log(rendered.markdown)

    return written
  })

export const brief = Command.make(
  "brief",
  { sinceHoursOpt, dateOpt, maxItemsOpt, dryRunOpt, llmOpt },
  ({
    sinceHoursOpt: sinceHours,
    dateOpt: dateOptVal,
    maxItemsOpt: maxItemsOptVal,
    dryRunOpt: dryRun,
    llmOpt: llmKind,
  }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const date = Option.getOrElse(dateOptVal, today)
      yield* Console.log(`generating brief for ${date} from ${vaultDir} (llm=${llmKind})`)
      const program = makeBriefProgram({ date, sinceHours, maxItemsOpt: maxItemsOptVal, dryRun })
      const llmLayer = llmKind === "stub" ? StubLlmLive : buildLlmLayer(resolveMode())
      yield* program.pipe(
        Effect.provide(FileSystemProfileLive(vaultDir)),
        Effect.provide(FileSystemVaultLive(vaultDir)),
        Effect.provide(llmLayer),
        Effect.provide(StrictRendererLive),
        Effect.provide(EnvSecretsLive),
      )
    }),
).pipe(Command.withDescription("Generate a daily brief from wiki pages + stub LLM"))
