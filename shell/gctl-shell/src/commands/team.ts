import { Command, Options } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

const PersonaDefinition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  focus: Schema.String,
  prompt_prefix: Schema.String,
  owns: Schema.String,
  review_focus: Schema.String,
  pushes_back: Schema.String,
  tools: Schema.Array(Schema.String),
  key_specs: Schema.Array(Schema.String),
})

const TeamRecommendation = Schema.Struct({
  personas: Schema.Array(PersonaDefinition),
  rationale: Schema.String,
})

const RenderedPrompt = Schema.Struct({
  persona_id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
})

const TeamRenderResult = Schema.Struct({
  agents: Schema.Array(RenderedPrompt),
})

// --- recommend ---

const formatOption = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table"),
)

const labelsOption = Options.text("labels").pipe(Options.optional)
const prTypeOption = Options.text("pr-type").pipe(Options.optional)

const recommendCommand = Command.make(
  "recommend",
  { labels: labelsOption, prType: prTypeOption, format: formatOption },
  ({ labels, prType, format }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient

      const body: Record<string, unknown> = {}
      if (labels._tag === "Some") {
        body.labels = labels.value.split(",").map((l: string) => l.trim())
      }
      if (prType._tag === "Some") {
        body.pr_type = prType.value
      }

      const result = yield* kernel.post("/api/team/recommend", body, TeamRecommendation)

      if (format === "json") {
        yield* Console.log(JSON.stringify(result, null, 2))
        return
      }

      yield* Console.log(`Rationale: ${result.rationale}`)
      yield* Console.log("")
      yield* Console.log(`${"ID".padEnd(14)} ${"Name".padEnd(35)} Focus`)
      yield* Console.log("-".repeat(80))
      for (const p of result.personas) {
        yield* Console.log(
          `${p.id.padEnd(14)} ${p.name.padEnd(35)} ${p.focus.substring(0, 30)}`
        )
      }
    }),
)

// --- render ---

const personaIdsOption = Options.text("personas")
const issueOption = Options.text("issue").pipe(Options.optional)

const renderCommand = Command.make(
  "render",
  { personaIds: personaIdsOption, issue: issueOption, format: formatOption },
  ({ personaIds, issue, format }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient

      const ids = personaIds.split(",").map((id: string) => id.trim())
      const body: Record<string, unknown> = { persona_ids: ids }

      if (issue._tag === "Some") {
        body.context = { issue_key: issue.value }
      }

      const result = yield* kernel.post("/api/team/render", body, TeamRenderResult)

      if (format === "json") {
        yield* Console.log(JSON.stringify(result, null, 2))
        return
      }

      for (const agent of result.agents) {
        yield* Console.log(`=== ${agent.name} (${agent.persona_id}) ===`)
        yield* Console.log(agent.prompt)
        yield* Console.log("")
      }
    }),
)

// --- compose ---

export const teamCommand = Command.make("team").pipe(
  Command.withSubcommands([recommendCommand, renderCommand]),
)
