/**
 * `gctrl app` — scaffold and manage gctrl native applications.
 *
 * `gctrl app bootstrap <name> [--description ...]` reads the canonical PRD
 * template + the worked example PRD, asks the kernel LLM relay (or any
 * OpenAI-compatible endpoint at $GCTRL_LLM_URL) to draft PRD.md / WORKFLOW.md /
 * ROADMAP.md grounded in those files, and writes the result under
 * `apps/<name>/`. Default model is claude-opus-4-7.
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { mkdir, readFile, writeFile, access } from "node:fs/promises"
import { join, resolve } from "node:path"

const DEFAULT_LLM_URL = "http://127.0.0.1:4319/v1/chat/completions"
const DEFAULT_MODEL = "claude-opus-4-7"
const TEMPLATE_PATH = "apps/gctrl-board/vault/specs/workflows/prd-template.md"
const EXAMPLE_PATH = "apps/gctrl-board/vault/specs/workflows/prd-example.md"

const KEBAB = /^[a-z][a-z0-9-]*[a-z0-9]$/

class BootstrapError {
  readonly _tag = "BootstrapError"
  constructor(readonly message: string) {}
}

const fail = (msg: string) => Effect.fail(new BootstrapError(msg))

const readUtf8 = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (e) => new BootstrapError(`Cannot read ${path}: ${e}`),
  })

const writeUtf8 = (path: string, content: string) =>
  Effect.tryPromise({
    try: () => writeFile(path, content, "utf8"),
    catch: (e) => new BootstrapError(`Cannot write ${path}: ${e}`),
  })

const ensureDir = (path: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }).then(() => undefined),
    catch: (e) => new BootstrapError(`Cannot mkdir ${path}: ${e}`),
  })

const exists = (path: string) =>
  Effect.tryPromise({
    try: () => access(path).then(() => true).catch(() => false),
    catch: () => new BootstrapError(`access failed: ${path}`),
  })

const stripCodeFence = (text: string): string => {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)
  return fence ? fence[1] : trimmed
}

const callLlm = (params: {
  url: string
  model: string
  system: string
  user: string
  maxTokens: number
}) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(params.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-name": "gctrl-app-bootstrap",
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.maxTokens,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`LLM ${res.status}: ${body.slice(0, 400)}`)
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error("LLM response missing choices[0].message.content")
      return stripCodeFence(content)
    },
    catch: (e) =>
      new BootstrapError(
        `LLM call failed (url=${params.url}). Is the kernel relay running? ${e}`,
      ),
  })

const PRD_SYSTEM = `You are drafting a Product Requirements Document for a new gctrl native application. Follow the provided template structure exactly. Match the tone and section depth of the worked example. The example app (gctrl-digest) is fictional — do NOT copy its content; copy its shape. Output Markdown only — no prose wrapper, no code-fence around the whole document.`

const prdUserPrompt = (
  template: string,
  example: string,
  name: string,
  description: string,
) => `<TEMPLATE>
${template}
</TEMPLATE>

<EXAMPLE>
${example}
</EXAMPLE>

App name: ${name}
One-line description: ${description}

Draft PRD.md for this app. Required sections: Architectural Position (with a mermaid flowchart placing the app between Shell, Kernel, and Drivers), Problem (3–7 numbered pain points), Our Take, Principles (numbered, MUST/MUST NOT language), Target Users (Primary + Secondary tables), Use Cases (3–5 with Problem/Solution/Success metric), What We're Building (capability list, not architecture), Roadmap (Shipped / Next / Backlog tables matching the example), Non-Goals, Success Criteria, Open Questions. Use bare \`[[slug]]\` wikilinks only — never typed prefixes. Use \`gctrl ${name} ...\` for CLI examples. Reference kernel HTTP API as \`:4318\`. Use \`${name.replace(/-/g, "_")}_*\` as the table-namespace prefix.`

const WORKFLOW_SYSTEM = `You are drafting a WORKFLOW.md for a gctrl native application. The doc covers concrete CLI commands, HTTP routes, storage schema, and any state-machine diagrams. Output Markdown only.`

const workflowUserPrompt = (prd: string, name: string) => `Here is the PRD for ${name}:

${prd}

Draft WORKFLOW.md. Include: state-machine mermaid diagram for the primary entity lifecycle, CLI command list (\`gctrl ${name} ...\`), HTTP API routes table (under \`/api/${name.replace(/-/g, "_")}/*\`), storage schema (\`${name.replace(/-/g, "_")}_*\` tables with CREATE TABLE / CREATE INDEX statements), and integration points with other gctrl apps via kernel IPC.`

const ROADMAP_SYSTEM = `You are drafting a ROADMAP.md for a gctrl native application — milestone-by-milestone breakdown that maps directly to gctrl-board issues. Output Markdown only.`

const roadmapUserPrompt = (prd: string, name: string) => `Here is the PRD for ${name}:

${prd}

Draft ROADMAP.md. Use M0/M1/M2/M3 milestones, each with a target outcome and a feature × priority × issue table. End with a Backlog section. Each row should be createable as an issue via \`gctrl board create --project ${name.toUpperCase().replace(/-/g, "_")} ...\`.`

// --- subcommand: bootstrap ---

const nameArg = Args.text({ name: "name" })
const descriptionOpt = Options.text("description").pipe(
  Options.optional,
  Options.withAlias("d"),
  Options.withDescription("One-line description of the app"),
)
const modelOpt = Options.text("model").pipe(
  Options.withDefault(DEFAULT_MODEL),
  Options.withDescription(`Model name passed to the LLM relay (default: ${DEFAULT_MODEL})`),
)
const llmUrlOpt = Options.text("llm-url").pipe(
  Options.withDefault(process.env.GCTRL_LLM_URL ?? DEFAULT_LLM_URL),
  Options.withDescription(
    "OpenAI-compatible chat-completions URL (default: $GCTRL_LLM_URL or kernel relay on :4319)",
  ),
)
const forceOpt = Options.boolean("force").pipe(
  Options.withDefault(false),
  Options.withDescription("Overwrite an existing apps/<name>/ directory"),
)
const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDefault(false),
  Options.withDescription("Print what would be generated; do not write files"),
)

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    name: nameArg,
    description: descriptionOpt,
    model: modelOpt,
    llmUrl: llmUrlOpt,
    force: forceOpt,
    dryRun: dryRunOpt,
  },
  ({ name, description, model, llmUrl, force, dryRun }) =>
    Effect.gen(function* () {
      if (!KEBAB.test(name)) {
        return yield* fail(
          `Invalid app name '${name}'. Use kebab-case slug (e.g. gctrl-watch).`,
        )
      }

      const cwd = process.cwd()
      const appsDir = resolve(cwd, "apps")
      if (!(yield* exists(appsDir))) {
        return yield* fail(
          `No apps/ directory at ${cwd}. Run from the gctrl repo root.`,
        )
      }

      const appDir = join(appsDir, name)
      if ((yield* exists(appDir)) && !force) {
        return yield* fail(
          `apps/${name}/ already exists. Re-run with --force to overwrite.`,
        )
      }

      const desc = Option.getOrElse(description, () => `A new gctrl native application named ${name}.`)

      const templatePath = resolve(cwd, TEMPLATE_PATH)
      const examplePath = resolve(cwd, EXAMPLE_PATH)

      yield* Console.log(`→ Bootstrapping apps/${name}/`)
      yield* Console.log(`  template: ${TEMPLATE_PATH}`)
      yield* Console.log(`  example:  ${EXAMPLE_PATH}`)
      yield* Console.log(`  model:    ${model}`)
      yield* Console.log(`  llm-url:  ${llmUrl}`)

      const template = yield* readUtf8(templatePath)
      const example = yield* readUtf8(examplePath)

      yield* Console.log("→ Drafting PRD.md (this can take 30–90s)…")
      const prd = yield* callLlm({
        url: llmUrl,
        model,
        system: PRD_SYSTEM,
        user: prdUserPrompt(template, example, name, desc),
        maxTokens: 8000,
      })

      yield* Console.log("→ Drafting WORKFLOW.md…")
      const workflow = yield* callLlm({
        url: llmUrl,
        model,
        system: WORKFLOW_SYSTEM,
        user: workflowUserPrompt(prd, name),
        maxTokens: 4000,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            `# ${name} — Workflow\n\n> Draft generation failed (${e.message}). Re-run \`gctrl app bootstrap ${name}\` or fill in by hand.\n`,
          ),
        ),
      )

      yield* Console.log("→ Drafting ROADMAP.md…")
      const roadmap = yield* callLlm({
        url: llmUrl,
        model,
        system: ROADMAP_SYSTEM,
        user: roadmapUserPrompt(prd, name),
        maxTokens: 3000,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            `# ${name} — Roadmap\n\n> Draft generation failed (${e.message}). See PRD.md Roadmap section.\n`,
          ),
        ),
      )

      if (dryRun) {
        yield* Console.log("\n--- PRD.md (preview, first 40 lines) ---")
        yield* Console.log(prd.split("\n").slice(0, 40).join("\n"))
        yield* Console.log("\n[dry-run] No files written.")
        return
      }

      yield* ensureDir(join(appDir, "vault", "specs"))
      yield* writeUtf8(join(appDir, "PRD.md"), prd.endsWith("\n") ? prd : prd + "\n")
      yield* writeUtf8(
        join(appDir, "WORKFLOW.md"),
        workflow.endsWith("\n") ? workflow : workflow + "\n",
      )
      yield* writeUtf8(
        join(appDir, "ROADMAP.md"),
        roadmap.endsWith("\n") ? roadmap : roadmap + "\n",
      )
      yield* writeUtf8(join(appDir, "vault", ".gitkeep"), "")
      yield* writeUtf8(join(appDir, "vault", "specs", ".gitkeep"), "")

      yield* Console.log("")
      yield* Console.log(`✓ Bootstrapped apps/${name}/`)
      yield* Console.log(`  - apps/${name}/PRD.md`)
      yield* Console.log(`  - apps/${name}/WORKFLOW.md`)
      yield* Console.log(`  - apps/${name}/ROADMAP.md`)
      yield* Console.log(`  - apps/${name}/vault/{,specs/}.gitkeep`)
      yield* Console.log("")
      yield* Console.log("Next: review PRD.md, then commit on a feature branch.")
    }).pipe(
      Effect.catchTag("BootstrapError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`✗ ${e.message}`)
          yield* Effect.sync(() => process.exit(1))
        }),
      ),
    ),
)

// --- app (parent) ---

export const appCommand = Command.make("app").pipe(
  Command.withSubcommands([bootstrapCommand]),
)
