import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { StubLlmLive } from "../adapters/StubLlm.js"
import { resolveVaultDir } from "../lib/env.js"
import { LlmService } from "../services/LlmService.js"
import { ProfileService } from "../services/ProfileService.js"
import { VaultService } from "../services/VaultService.js"

const sinceHours = Options.integer("since-hours").pipe(
  Options.withDescription("Window of recently-changed pages to feed the LLM"),
  Options.withDefault(24 * 7),
)

const dateOpt = Options.text("date").pipe(
  Options.withDescription("Brief date (YYYY-MM-DD); defaults to today"),
  Options.optional,
)

const today = () => new Date().toISOString().slice(0, 10)

const renderBrief = (
  date: string,
  topicsCovered: ReadonlyArray<string>,
  generator: string,
  items: ReadonlyArray<{ heading: string; body: string; citations: ReadonlyArray<string> }>,
) => {
  const fm = [
    "---",
    "page_type: brief",
    `slug: brief-${date}`,
    `date: "${date}"`,
    `generator: ${generator}`,
    `topics_covered: [${topicsCovered.join(", ")}]`,
    "---",
    "",
    `# Daily brief — ${date}`,
    "",
  ].join("\n")
  const body = items
    .map((it) => `### ${it.heading}\n\n${it.body.trim()}\n`)
    .join("\n")
  return `${fm}${body}`
}

export const brief = Command.make(
  "brief",
  { sinceHours, dateOpt },
  ({ sinceHours: sinceHoursVal, dateOpt: dateOptVal }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const date = dateOptVal._tag === "Some" ? dateOptVal.value : today()
      yield* Console.log(`generating brief for ${date} from ${vaultDir}`)
      const profileLayer = FileSystemProfileLive(vaultDir)
      const vaultLayer = FileSystemVaultLive(vaultDir)
      const program = Effect.gen(function* () {
        const profileSvc = yield* ProfileService
        const vaultSvc = yield* VaultService
        const llm = yield* LlmService
        const profile = yield* profileSvc.load()
        const pages = yield* vaultSvc.recentlyChanged(sinceHoursVal)
        yield* Console.log(`  ${pages.length} page(s) changed in last ${sinceHoursVal}h`)
        const response = yield* llm.generateBrief({
          date,
          profileName: profile.profile.identity.name,
          pages,
          topics: profile.topics.topics.map((t) => t.slug),
        })
        const rendered = renderBrief(date, response.topicsCovered, llm.name(), response.items)
        const written = yield* vaultSvc.writeBrief(date, rendered)
        yield* Console.log(`✓ wrote ${written.relPath} (${written.contentHash})`)
        yield* Console.log("")
        yield* Console.log(rendered)
      })
      yield* program.pipe(
        Effect.provide(profileLayer),
        Effect.provide(vaultLayer),
        Effect.provide(StubLlmLive),
      )
    }),
).pipe(Command.withDescription("Generate a daily brief from wiki pages + stub LLM"))
