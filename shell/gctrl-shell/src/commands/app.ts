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
import { Console, Effect, Option, Schema } from "effect"
import { mkdir, readFile, writeFile, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { KernelClient } from "../services/KernelClient"

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

const LlmResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
})

const callLlm = (params: {
  url: string
  model: string
  system: string
  user: string
  maxTokens: number
}) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(params.url, {
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
        }),
      catch: (e) =>
        new BootstrapError(
          `LLM call failed (url=${params.url}). Is the kernel relay running? ${e}`,
        ),
    })

    if (!res.ok) {
      const body = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new BootstrapError(`LLM ${res.status}: <unreadable body>`),
      }).pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(
        new BootstrapError(`LLM ${res.status}: ${body.slice(0, 400)}`),
      )
    }

    const raw = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: (e) => new BootstrapError(`LLM response not JSON: ${e}`),
    })

    const decoded = yield* Schema.decodeUnknown(LlmResponse)(raw).pipe(
      Effect.mapError(
        (e) => new BootstrapError(`LLM response decode failed: ${e}`),
      ),
    )

    const content = decoded.choices?.[0]?.message?.content
    if (!content) {
      return yield* Effect.fail(
        new BootstrapError("LLM response missing choices[0].message.content"),
      )
    }
    return stripCodeFence(content)
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
  Options.withDescription("Overwrite an existing target directory"),
)
const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDefault(false),
  Options.withDescription("Print what would be generated; do not write files"),
)
const targetOpt = Options.text("target").pipe(
  Options.optional,
  Options.withDescription(
    "Output directory for the bootstrapped app (default: apps/<name> relative to CWD). " +
      "Use this to scaffold into another repo or a non-default location.",
  ),
)
const gctrlRootOpt = Options.text("gctrl-root").pipe(
  Options.optional,
  Options.withDescription(
    "Path to a gctrl repo checkout used to resolve PRD template + example " +
      "(default: $GCTRL_REPO_ROOT, else CWD if it has the templates). " +
      "Required when --target points outside the gctrl repo and CWD isn't a gctrl checkout.",
  ),
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
    target: targetOpt,
    gctrlRoot: gctrlRootOpt,
  },
  ({ name, description, model, llmUrl, force, dryRun, target, gctrlRoot }) =>
    Effect.gen(function* () {
      if (!KEBAB.test(name)) {
        return yield* fail(
          `Invalid app name '${name}'. Use kebab-case slug (e.g. gctrl-watch).`,
        )
      }

      const cwd = process.cwd()
      const explicitTarget = Option.getOrUndefined(target)
      const explicitRoot = Option.getOrUndefined(gctrlRoot)

      // Resolve the gctrl repo root for template/example lookup.
      // Order: --gctrl-root → $GCTRL_REPO_ROOT → CWD.
      const candidateRoots: string[] = []
      if (explicitRoot) candidateRoots.push(resolve(explicitRoot))
      if (process.env.GCTRL_REPO_ROOT) candidateRoots.push(resolve(process.env.GCTRL_REPO_ROOT))
      candidateRoots.push(cwd)

      let resolvedRoot: string | null = null
      for (const root of candidateRoots) {
        if (yield* exists(join(root, TEMPLATE_PATH))) {
          resolvedRoot = root
          break
        }
      }
      if (resolvedRoot === null) {
        return yield* fail(
          `Cannot find PRD template (${TEMPLATE_PATH}). ` +
            `Pass --gctrl-root <path> to a gctrl repo checkout, set $GCTRL_REPO_ROOT, ` +
            `or run from the gctrl repo root.`,
        )
      }

      // Resolve the output directory.
      // --target → full app dir (use as-is). Otherwise apps/<name> in CWD.
      const appDir = explicitTarget
        ? resolve(explicitTarget)
        : join(resolve(cwd, "apps"), name)

      if (!explicitTarget) {
        const appsDir = resolve(cwd, "apps")
        if (!(yield* exists(appsDir))) {
          return yield* fail(
            `No apps/ directory at ${cwd}. Run from the gctrl repo root, ` +
              `or pass --target <path> to bootstrap into another location.`,
          )
        }
      }

      if ((yield* exists(appDir)) && !force) {
        return yield* fail(
          `${appDir} already exists. Re-run with --force to overwrite.`,
        )
      }

      const desc = Option.getOrElse(description, () => `A new gctrl native application named ${name}.`)

      const templatePath = join(resolvedRoot, TEMPLATE_PATH)
      const examplePath = join(resolvedRoot, EXAMPLE_PATH)

      yield* Console.log(`→ Bootstrapping ${appDir}`)
      yield* Console.log(`  gctrl-root: ${resolvedRoot}`)
      yield* Console.log(`  template:   ${TEMPLATE_PATH}`)
      yield* Console.log(`  example:    ${EXAMPLE_PATH}`)
      yield* Console.log(`  model:      ${model}`)
      yield* Console.log(`  llm-url:    ${llmUrl}`)

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
      yield* Console.log(`✓ Bootstrapped ${appDir}`)
      yield* Console.log(`  - ${join(appDir, "PRD.md")}`)
      yield* Console.log(`  - ${join(appDir, "WORKFLOW.md")}`)
      yield* Console.log(`  - ${join(appDir, "ROADMAP.md")}`)
      yield* Console.log(`  - ${join(appDir, "vault")}/{,specs/}.gitkeep`)
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

// =============================================================================
// install / list / status / reload / uninstall — gctrl-app.toml workflow.
//
// The kernel handles parsing + validation + persistence. The shell just
// reads the manifest from disk and POSTs it through KernelClient. See
// vault/specs/architecture/app-install-protocol.md for the contract.
// =============================================================================

// --- schemas (mirror kernel/crates/gctrl-core::AppInstall + AppBinding + VaultMount) ---

const AppInstallSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  source_ref: Schema.String,
  manifest_sha: Schema.String,
  installed_at: Schema.String,
  reloaded_at: Schema.NullOr(Schema.String),
})

const AppBindingSchema = Schema.Struct({
  install_name: Schema.String,
  capability: Schema.String,
  driver_id: Schema.String,
  required: Schema.Boolean,
  resolved_at: Schema.String,
})

const VaultMountSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root_path: Schema.String,
  kind: Schema.String,
  app_id: Schema.NullOr(Schema.String),
})

const AppInstallViewSchema = Schema.Struct({
  install: AppInstallSchema,
  bindings: Schema.Array(AppBindingSchema),
  vault_mounts: Schema.Array(VaultMountSchema),
})

const AppInstallListSchema = Schema.Array(AppInstallSchema)

const CapabilitySchema = Schema.Struct({
  id: Schema.String,
  default_driver: Schema.String,
  route_prefix: Schema.String,
  description: Schema.String,
})
const CapabilityListSchema = Schema.Array(CapabilitySchema)

const VoidSchema = Schema.Struct({})

// --- shared helpers ---

const readManifest = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(resolve(path), "utf8"),
    catch: (e) => new BootstrapError(`Cannot read manifest at ${path}: ${e}`),
  })

const printInstallView = (view: typeof AppInstallViewSchema.Type) =>
  Effect.gen(function* () {
    yield* Console.log(`✓ ${view.install.name}@${view.install.version}`)
    yield* Console.log(`  source_ref:   ${view.install.source_ref}`)
    yield* Console.log(`  manifest_sha: ${view.install.manifest_sha.slice(0, 12)}…`)
    yield* Console.log(`  installed_at: ${view.install.installed_at}`)
    if (view.install.reloaded_at !== null) {
      yield* Console.log(`  reloaded_at:  ${view.install.reloaded_at}`)
    }
    if (view.bindings.length > 0) {
      yield* Console.log(`\n  capabilities (${view.bindings.length}):`)
      for (const b of view.bindings) {
        const tag = b.required ? "required" : "optional"
        yield* Console.log(
          `    ${b.capability.padEnd(24)} → ${b.driver_id.padEnd(20)} (${tag})`,
        )
      }
    }
    if (view.vault_mounts.length > 0) {
      yield* Console.log(`\n  vault project keys:`)
      for (const m of view.vault_mounts) {
        yield* Console.log(`    ${m.name} (kind=${m.kind})`)
      }
    }
  })

// --- install ---

const manifestPathArg = Args.text({ name: "manifest-path" }).pipe(
  Args.withDescription(
    "Path to the app's gctrl-app.toml (typically apps/<name>/gctrl-app.toml).",
  ),
)

const sourceRefOpt = Options.text("source-ref").pipe(
  Options.optional,
  Options.withDescription(
    "Override the source_ref recorded with the install (default: absolute manifest path).",
  ),
)

const installCommand = Command.make(
  "install",
  { manifestPath: manifestPathArg, sourceRef: sourceRefOpt },
  ({ manifestPath, sourceRef }) =>
    Effect.gen(function* () {
      const text = yield* readManifest(manifestPath)
      const ref = Option.getOrElse(sourceRef, () => resolve(manifestPath))
      const kernel = yield* KernelClient
      const view = yield* kernel.post(
        "/api/app/installs",
        { source_ref: ref, manifest_text: text },
        AppInstallViewSchema,
      )
      yield* printInstallView(view)
    }).pipe(
      Effect.catchTag("BootstrapError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`✗ ${e.message}`)
          yield* Effect.sync(() => process.exit(1))
        }),
      ),
    ),
).pipe(Command.withDescription("Install a gctrl app from its gctrl-app.toml manifest."))

// --- list ---

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const installs = yield* kernel.get("/api/app/installs", AppInstallListSchema)
    if (installs.length === 0) {
      yield* Console.log("No apps installed.")
      return
    }
    yield* Console.log(
      `${"NAME".padEnd(24)} ${"VERSION".padEnd(12)} ${"INSTALLED".padEnd(20)} SOURCE`,
    )
    yield* Console.log("-".repeat(80))
    for (const i of installs) {
      yield* Console.log(
        `${i.name.padEnd(24)} ${i.version.padEnd(12)} ${i.installed_at.slice(0, 19).padEnd(20)} ${i.source_ref}`,
      )
    }
  }),
).pipe(Command.withDescription("List installed apps."))

// --- status ---

const nameArgGeneric = Args.text({ name: "name" }).pipe(
  Args.withDescription("App name (matches the manifest's [app] name)."),
)

const statusCommand = Command.make("status", { name: nameArgGeneric }, ({ name }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const view = yield* kernel.get(`/api/app/installs/${name}`, AppInstallViewSchema)
    yield* printInstallView(view)
  }),
).pipe(Command.withDescription("Show install record + bindings + vault project keys for an app."))

// --- reload ---

const reloadCommand = Command.make(
  "reload",
  { name: nameArgGeneric, manifestPath: manifestPathArg, sourceRef: sourceRefOpt },
  ({ name, manifestPath, sourceRef }) =>
    Effect.gen(function* () {
      const text = yield* readManifest(manifestPath)
      const ref = Option.getOrElse(sourceRef, () => resolve(manifestPath))
      const kernel = yield* KernelClient
      const view = yield* kernel.post(
        `/api/app/installs/${name}/reload`,
        { source_ref: ref, manifest_text: text },
        AppInstallViewSchema,
      )
      yield* printInstallView(view)
    }).pipe(
      Effect.catchTag("BootstrapError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`✗ ${e.message}`)
          yield* Effect.sync(() => process.exit(1))
        }),
      ),
    ),
).pipe(Command.withDescription("Re-apply a manifest after editing it (e.g. on version bump)."))

// --- uninstall ---

const uninstallCommand = Command.make("uninstall", { name: nameArgGeneric }, ({ name }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    yield* kernel.delete(`/api/app/installs/${name}`)
    yield* Console.log(`✓ Uninstalled ${name}`)
    yield* Console.log(
      `  Vault project-key registrations dropped; files in the kernel vault root were NOT touched.`,
    )
  }),
).pipe(
  Command.withDescription(
    "Uninstall an app — drops install record, bindings, and project-key registrations (files preserved).",
  ),
)

// --- capabilities ---

const capabilitiesCommand = Command.make("capabilities", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const caps = yield* kernel.get("/api/app/capabilities", CapabilityListSchema)
    yield* Console.log(`${"ID".padEnd(24)} ${"DEFAULT DRIVER".padEnd(24)} ROUTE PREFIX`)
    yield* Console.log("-".repeat(80))
    for (const c of caps) {
      yield* Console.log(
        `${c.id.padEnd(24)} ${c.default_driver.padEnd(24)} ${c.route_prefix}`,
      )
    }
  }),
).pipe(
  Command.withDescription(
    "List the capabilities this kernel knows how to fulfill (the registry).",
  ),
)

// Suppress unused-warning for VoidSchema (kept for future delete/reload responses).
void VoidSchema

// --- app (parent) ---

export const appCommand = Command.make("app").pipe(
  Command.withSubcommands([
    bootstrapCommand,
    installCommand,
    listCommand,
    statusCommand,
    reloadCommand,
    uninstallCommand,
    capabilitiesCommand,
  ]),
)
