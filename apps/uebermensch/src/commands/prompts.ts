import { createHash } from "node:crypto"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Either, Option } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemQueryLive } from "../adapters/FileSystemQuery.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { resolveVaultDir } from "../lib/env.js"
import { DIRECTIVES_PROMPTS_DIR, INPUT_REPORTS_DIR } from "../lib/vault-paths.js"
import type { LlmError } from "../errors.js"
import {
  LlmService,
  type LlmServiceShape,
  type ResearchQueryContextPage,
  type ThoughtAnalysis,
  type ThoughtThesisRef,
} from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import {
  type Prompt,
  QueryService,
} from "../services/QueryService.js"
import {
  type ThesisRef,
  VaultService,
  type WikiPage,
} from "../services/VaultService.js"

const MAX_CONTEXT_PAGES = 12
const MAX_EXCERPT_CHARS = 1500
const MAX_THESES = 8
const MAX_THESIS_EXCERPT_CHARS = 1200

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
  Options.withDescription(
    `Print the consolidated answer without writing to ${INPUT_REPORTS_DIR}/`,
  ),
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

const selectTheses = (
  theses: ReadonlyArray<ThesisRef>,
  prompt: Prompt,
): ReadonlyArray<ThoughtThesisRef> => {
  if (theses.length === 0) return []
  const promptTopics = new Set(prompt.topics)
  // Without prompt topics, hand the LLM every thesis (capped) and let it pick.
  // With topics, prefer overlapping theses; fall back to the full list when
  // none overlap so the LLM can still propose addendums.
  const scored = theses
    .map((t) => {
      const overlap =
        promptTopics.size === 0
          ? 0
          : t.topics.reduce((n, x) => (promptTopics.has(x) ? n + 1 : n), 0)
      return { t, overlap }
    })
    .sort((a, b) => b.overlap - a.overlap)
  const overlapping = scored.filter((x) => x.overlap > 0)
  const chosen = overlapping.length > 0 ? overlapping : scored
  return chosen.slice(0, MAX_THESES).map(({ t }) => ({
    slug: t.slug,
    title: t.title,
    topics: t.topics,
    excerpt: excerptOf(t.body, MAX_THESIS_EXCERPT_CHARS),
  }))
}

const renderThoughtPage = (args: {
  prompt: Prompt
  analysis: ThoughtAnalysis
  promptHash: string
  model: string
  costUsd: number
  generatedAt: string
}): string => {
  const { prompt, analysis } = args
  const fm = [
    "---",
    `page_type: thought`,
    `slug: ${prompt.slug}`,
    `title: ${JSON.stringify(prompt.title)}`,
    `source_prompt: ${DIRECTIVES_PROMPTS_DIR}/archived/${prompt.slug}.md`,
    `topics: [${prompt.topics.join(", ")}]`,
    `generated_at: ${args.generatedAt}`,
    `model: ${args.model}`,
    `prompt_hash: ${args.promptHash}`,
    `cost_usd: ${args.costUsd.toFixed(6)}`,
    "---",
    "",
  ].join("\n")
  const lines: Array<string> = []
  lines.push(`## Intent`)
  lines.push("")
  lines.push(analysis.intent.trim() || "(no extractable intent)")
  lines.push("")
  lines.push(`## Questions`)
  lines.push("")
  if (analysis.questions.length === 0) {
    lines.push("- (none)")
  } else {
    for (const q of analysis.questions) lines.push(`- ${q}`)
  }
  lines.push("")
  lines.push(`## Relevant sources`)
  lines.push("")
  if (analysis.relevantPageStems.length === 0) {
    lines.push("(no wiki context yet)")
  } else {
    for (const stem of analysis.relevantPageStems) lines.push(`- [[${stem}]]`)
  }
  lines.push("")
  lines.push(`## Suggested thesis updates`)
  lines.push("")
  if (analysis.thesisUpdates.length === 0) {
    lines.push(
      "(none — the note did not bear on any thesis under directives/theses/)",
    )
  } else {
    lines.push(
      "Paste each addendum into the named thesis file under `directives/theses/` if you agree — CoS does not edit your authored theses.",
    )
    lines.push("")
    for (const u of analysis.thesisUpdates) {
      lines.push(`### [[${u.thesisSlug}]]`)
      lines.push("")
      lines.push(u.addendumMd.trim())
      lines.push("")
      lines.push(`*Why:* ${u.rationale.trim()}`)
      lines.push("")
    }
  }
  return `${fm}${lines.join("\n").trimEnd()}\n`
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
    `source_prompt: ${DIRECTIVES_PROMPTS_DIR}/${args.prompt.slug}.md`,
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

type Built = {
  readonly markdown: string
  readonly promptHash: string
  readonly costUsd: number
  readonly model: string
}

const runQuery = (args: {
  llm: LlmServiceShape
  prompt: Prompt
  note: string
  profileName: string
  contextPages: ReadonlyArray<ResearchQueryContextPage>
}): Effect.Effect<Either.Either<Built, LlmError>, never> =>
  Effect.gen(function* () {
    yield* Console.log(
      `  → ${args.prompt.slug} [query]: ${args.contextPages.length} context page(s); requesting research ...`,
    )
    const result = yield* args.llm
      .researchQuery({
        slug: args.prompt.slug,
        title: args.prompt.title,
        topics: args.prompt.topics,
        question: args.note,
        profileName: args.profileName,
        contextPages: args.contextPages,
      })
      .pipe(
        Effect.tapError((e) =>
          Console.log(
            `  ✗ ${args.prompt.slug}: llm failed (${e.kind ?? "unknown"}): ${e.message}`,
          ),
        ),
        Effect.either,
      )
    return Either.map(result, (r) => ({
      markdown: renderResearchPage({
        prompt: args.prompt,
        answerMd: r.answerMd,
        promptHash: r.promptHash,
        model: r.model,
        costUsd: r.costUsd,
        generatedAt: new Date().toISOString(),
      }),
      promptHash: r.promptHash,
      costUsd: r.costUsd,
      model: r.model,
    }))
  })

const runThought = (args: {
  llm: LlmServiceShape
  prompt: Prompt
  note: string
  profileName: string
  contextPages: ReadonlyArray<ResearchQueryContextPage>
  theses: ReadonlyArray<ThoughtThesisRef>
}): Effect.Effect<Either.Either<Built, LlmError>, never> =>
  Effect.gen(function* () {
    yield* Console.log(
      `  → ${args.prompt.slug} [thought]: ${args.contextPages.length} context page(s), ${args.theses.length} thesis candidate(s); analyzing ...`,
    )
    const result = yield* args.llm
      .analyzeThought({
        slug: args.prompt.slug,
        title: args.prompt.title,
        topics: args.prompt.topics,
        note: args.note,
        profileName: args.profileName,
        contextPages: args.contextPages,
        theses: args.theses,
      })
      .pipe(
        Effect.tapError((e) =>
          Console.log(
            `  ✗ ${args.prompt.slug}: llm failed (${e.kind ?? "unknown"}): ${e.message}`,
          ),
        ),
        Effect.either,
      )
    return Either.map(result, (r) => ({
      markdown: renderThoughtPage({
        prompt: args.prompt,
        analysis: r.analysis,
        promptHash: r.promptHash,
        model: r.model,
        costUsd: r.costUsd,
        generatedAt: new Date().toISOString(),
      }),
      promptHash: r.promptHash,
      costUsd: r.costUsd,
      model: r.model,
    }))
  })

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const vaultDir = yield* resolveVaultDir()
    const program = Effect.gen(function* () {
      const queries = yield* QueryService
      const all = yield* queries.list()
      if (all.length === 0) {
        yield* Console.log(`(no prompts in ${vaultDir}/${DIRECTIVES_PROMPTS_DIR}/)`)
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
      yield* Console.log(
        `processing prompts in ${vaultDir}/${DIRECTIVES_PROMPTS_DIR}/ (llm=${llmKind})`,
      )

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
        const theses = yield* vault.listTheses()

        for (const prompt of targets) {
          const note = prompt.body.trim()
          if (note.length === 0) {
            yield* Console.log(`  ! ${prompt.slug}: empty body — skipping`)
            continue
          }
          const contextPages = selectContext(wikiPages, prompt)

          // Dispatch on kind. Both produce a markdown report at
          // input/reports/<slug>.md; thought additionally gets the prompt
          // archived so the user's directives/prompts/ stays a true inbox.
          const built =
            prompt.kind === "query"
              ? yield* runQuery({
                  llm,
                  prompt,
                  note,
                  profileName: profile.profile.identity.name,
                  contextPages,
                })
              : yield* runThought({
                  llm,
                  prompt,
                  note,
                  profileName: profile.profile.identity.name,
                  contextPages,
                  theses: selectTheses(theses, prompt),
                })

          const success = yield* Either.match(built, {
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

          const { markdown, promptHash, costUsd, model } = success
          const generatedAt = new Date().toISOString()

          if (dryRun) {
            yield* Console.log(`  (dry-run) ${prompt.slug} [${prompt.kind}]`)
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
            `  ✓ ${prompt.slug} [${prompt.kind}] → ${written.relPath} (${written.contentHash})`,
          )
          yield* Console.log(`    cost: $${costUsd.toFixed(4)} model=${model}`)

          // Thought workflow: source note moves to directives/prompts/archived/
          // so the inbox surface only ever shows pending notes.
          if (prompt.kind === "thought") {
            const archived = yield* queries.archive(prompt.slug).pipe(
              Effect.tapError((e) =>
                Console.log(
                  `    ! archive failed (${e.kind ?? "unknown"}): ${e.message}`,
                ),
              ),
              Effect.either,
            )
            if (archived._tag === "Right") {
              yield* Console.log(`    archived → ${archived.right.toRelPath}`)
            }
          }
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
    `Process pending prompts in $UBER_VAULT_DIR/${DIRECTIVES_PROMPTS_DIR}/ — research each via the LLM and write ${INPUT_REPORTS_DIR}/<slug>.md`,
  ),
)

export const _internal = {
  selectContext,
  selectTheses,
  renderResearchPage,
  renderThoughtPage,
  sha256,
}

export const prompts = Command.make("prompts").pipe(
  Command.withSubcommands([list, show, process_]),
  Command.withDescription(
    `Process user-authored research queries from $UBER_VAULT_DIR/${DIRECTIVES_PROMPTS_DIR}/`,
  ),
)
