import { createHash } from "node:crypto"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Either, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemQueryLive } from "../adapters/FileSystemQuery.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { resolveVaultDir } from "../lib/env.js"
import {
  LlmService,
  type ResearchQueryContextPage,
} from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import {
  type Prompt,
  QueryService,
} from "../services/QueryService.js"
import { VaultService, type WikiPage } from "../services/VaultService.js"

const MAX_CONTEXT_PAGES = 12
const MAX_EXCERPT_CHARS = 1500

const sha256 = (s: string): string =>
  `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`

const llmOpt = Options.choice("llm", ["kernel", "stub"]).pipe(
  Options.withDescription(
    "LLM backend: 'kernel' (real model via kernel /api/llm/messages) or 'stub'",
  ),
  Options.withDefault("kernel" as const),
)

const slugOpt = Options.text("slug").pipe(
  Options.withDescription("Process a single prompt by slug (default: all pending)"),
  Options.optional,
)

const forceOpt = Options.boolean("force").pipe(
  Options.withDescription("Re-process prompts whose status is 'processed'"),
  Options.withDefault(false),
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Print the consolidated answer without writing to wiki/research/"),
  Options.withDefault(false),
)

const titleOf = (p: WikiPage): string =>
  (p.frontmatter.title as string | undefined) ?? p.stem

const topicsOf = (p: WikiPage): ReadonlyArray<string> =>
  (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []

const excerptOf = (body: string, max: number): string => {
  const trimmed = body.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

const selectContext = (
  pages: ReadonlyArray<WikiPage>,
  prompt: Prompt,
): ReadonlyArray<ResearchQueryContextPage> => {
  if (pages.length === 0) return []
  const promptTopics = new Set(prompt.topics)
  const scored = pages
    .map((p) => {
      const pageTopics = topicsOf(p)
      const overlap =
        promptTopics.size === 0
          ? 0
          : pageTopics.reduce((n, t) => (promptTopics.has(t) ? n + 1 : n), 0)
      const recencyBoost = (Date.now() - p.mtime.getTime()) / 86_400_000 // days
      // higher overlap, then more recent
      return { p, overlap, recencyBoost }
    })
    .filter((x) => promptTopics.size === 0 || x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.recencyBoost - b.recencyBoost)
    .slice(0, MAX_CONTEXT_PAGES)
  return scored.map(({ p }) => ({
    stem: p.stem,
    title: titleOf(p),
    topics: topicsOf(p),
    excerpt: excerptOf(p.body, MAX_EXCERPT_CHARS),
  }))
}

const renderResearchPage = (args: {
  prompt: Prompt
  answerMd: string
  promptHash: string
  model: string
  costUsd: number
  generatedAt: string
}): string => {
  const fm = [
    "---",
    `page_type: research`,
    `slug: ${args.prompt.slug}`,
    `title: ${JSON.stringify(args.prompt.title)}`,
    `source_prompt: prompts/${args.prompt.slug}.md`,
    `topics: [${args.prompt.topics.join(", ")}]`,
    `generated_at: ${args.generatedAt}`,
    `model: ${args.model}`,
    `prompt_hash: ${args.promptHash}`,
    `cost_usd: ${args.costUsd.toFixed(6)}`,
    "---",
    "",
  ].join("\n")
  return `${fm}${args.answerMd.trimEnd()}\n`
}

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const vaultDir = yield* resolveVaultDir()
    const program = Effect.gen(function* () {
      const queries = yield* QueryService
      const all = yield* queries.list()
      if (all.length === 0) {
        yield* Console.log(`(no prompts in ${vaultDir}/prompts/)`)
        return
      }
      for (const p of all) {
        const out = p.output ? ` → ${p.output}` : ""
        const at = p.processedAt ? ` (${p.processedAt})` : ""
        yield* Console.log(`${p.status.padEnd(9)} ${p.slug}${out}${at}`)
      }
    })
    yield* program.pipe(Effect.provide(FileSystemQueryLive(vaultDir)))
  }),
).pipe(Command.withDescription("List prompts in the vault and their processing status"))

const show = Command.make(
  "show",
  { slug: Args.text({ name: "slug" }) },
  ({ slug }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const program = Effect.gen(function* () {
        const queries = yield* QueryService
        const p = yield* queries.get(slug)
        yield* Console.log(`# ${p.title}`)
        yield* Console.log(`slug: ${p.slug}  status: ${p.status}`)
        if (p.output) yield* Console.log(`output: ${p.output}`)
        if (p.processedAt) yield* Console.log(`processed_at: ${p.processedAt}`)
        if (p.model) yield* Console.log(`model: ${p.model}`)
        yield* Console.log("")
        yield* Console.log("--- prompt body ---")
        yield* Console.log(p.body.trim())
      })
      yield* program.pipe(Effect.provide(FileSystemQueryLive(vaultDir)))
    }),
).pipe(Command.withDescription("Show a prompt and its processing metadata"))

const process_ = Command.make(
  "process",
  { slugOpt, llmOpt, forceOpt, dryRunOpt },
  ({ slugOpt: slugOptVal, llmOpt: llmKind, forceOpt: force, dryRunOpt: dryRun }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      yield* Console.log(`processing prompts in ${vaultDir}/prompts/ (llm=${llmKind})`)

      const program = Effect.gen(function* () {
        const queries = yield* QueryService
        const vault = yield* VaultService
        const llm = yield* LlmService
        const profileSvc = yield* ProfileService
        const profile = yield* profileSvc.load()

        const onlySlug = Option.getOrUndefined(slugOptVal)
        const all = yield* queries.list()
        const targets = all.filter((p) => {
          if (onlySlug && p.slug !== onlySlug) return false
          if (p.status === "rerun") return true
          if (p.status === "processed" && !force) return false
          return true
        })

        if (targets.length === 0) {
          yield* Console.log(
            onlySlug
              ? `  no prompt matched slug=${onlySlug} (or already processed; --force to redo)`
              : "  no pending prompts",
          )
          return
        }

        const wikiPages = yield* vault.listWikiPages()

        for (const prompt of targets) {
          const question = prompt.body.trim()
          if (question.length === 0) {
            yield* Console.log(`  ! ${prompt.slug}: empty body — skipping`)
            continue
          }
          const contextPages = selectContext(wikiPages, prompt)
          yield* Console.log(
            `  → ${prompt.slug}: ${contextPages.length} context page(s); requesting research ...`,
          )
          const result = yield* llm
            .researchQuery({
              slug: prompt.slug,
              title: prompt.title,
              topics: prompt.topics,
              question,
              profileName: profile.profile.identity.name,
              contextPages,
            })
            .pipe(
              Effect.tapError((e) =>
                Console.log(`  ✗ ${prompt.slug}: llm failed (${e.kind ?? "unknown"}): ${e.message}`),
              ),
              Effect.either,
            )

          const success = yield* Either.match(result, {
            onLeft: (e) =>
              queries
                .stamp(prompt.slug, {
                  status: "failed",
                  processedAt: new Date().toISOString(),
                  failedReason: `${e.kind ?? "unknown"}: ${e.message}`,
                })
                .pipe(Effect.as(null)),
            onRight: (r) => Effect.succeed(r),
          })
          if (success === null) continue

          const { answerMd, promptHash, costUsd, model } = success
          const generatedAt = new Date().toISOString()
          const markdown = renderResearchPage({
            prompt,
            answerMd,
            promptHash,
            model,
            costUsd,
            generatedAt,
          })

          if (dryRun) {
            yield* Console.log(`  (dry-run) ${prompt.slug}`)
            yield* Console.log("")
            yield* Console.log(markdown)
            continue
          }

          const written = yield* vault.writeResearch(prompt.slug, markdown)
          yield* queries.stamp(prompt.slug, {
            status: "processed",
            output: written.relPath,
            processedAt: generatedAt,
            contentHash: written.contentHash,
            promptHash,
            model,
            costUsd,
          })
          yield* Console.log(
            `  ✓ ${prompt.slug} → ${written.relPath} (${written.contentHash})`,
          )
          yield* Console.log(`    cost: $${costUsd.toFixed(4)} model=${model}`)
        }
      })

      const llmLayer = llmKind === "stub" ? StubLlmLive : KernelLlmLive
      yield* program.pipe(
        Effect.provide(FileSystemQueryLive(vaultDir)),
        Effect.provide(FileSystemVaultLive(vaultDir)),
        Effect.provide(FileSystemProfileLive(vaultDir)),
        Effect.provide(llmLayer),
      )
    }),
).pipe(
  Command.withDescription(
    "Process pending prompts in $UBER_VAULT_DIR/prompts/ — research each via the LLM and write wiki/research/<slug>.md",
  ),
)

export const _internal = { selectContext, renderResearchPage, sha256 }

export const prompts = Command.make("prompts").pipe(
  Command.withSubcommands([list, show, process_]),
  Command.withDescription("Process user-authored research queries from $UBER_VAULT_DIR/prompts/"),
)
