import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
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
  source_hash: Schema.optional(Schema.NullOr(Schema.String)),
})
const PersonaList = Schema.Array(PersonaDefinition)

const SeedResult = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
})

// --- list ---

const formatOption = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table"),
)

const listCommand = Command.make("list", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const personas = yield* kernel.get("/api/personas", PersonaList)

    if (personas.length === 0) {
      yield* Console.log("No personas found. Run `gctl persona seed` to load from specs/team/personas.md")
      return
    }

    if (format === "json") {
      yield* Console.log(JSON.stringify(personas, null, 2))
      return
    }

    yield* Console.log(`${"ID".padEnd(14)} ${"Name".padEnd(35)} Focus`)
    yield* Console.log("-".repeat(80))
    for (const p of personas) {
      yield* Console.log(
        `${p.id.padEnd(14)} ${p.name.padEnd(35)} ${p.focus.substring(0, 30)}`
      )
    }
  }),
)

// --- get ---

const personaId = Args.text({ name: "id" })

const getCommand = Command.make("get", { id: personaId, format: formatOption }, ({ id, format }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const persona = yield* kernel.get(`/api/personas/${id}`, PersonaDefinition)

    if (format === "json") {
      yield* Console.log(JSON.stringify(persona, null, 2))
      return
    }

    yield* Console.log(`ID:           ${persona.id}`)
    yield* Console.log(`Name:         ${persona.name}`)
    yield* Console.log(`Focus:        ${persona.focus}`)
    yield* Console.log(`Owns:         ${persona.owns}`)
    yield* Console.log(`Reviews for:  ${persona.review_focus}`)
    yield* Console.log(`Pushes back:  ${persona.pushes_back}`)
    yield* Console.log(`Tools:        ${persona.tools.join(", ")}`)
    yield* Console.log(`Key specs:    ${persona.key_specs.join(", ")}`)
    yield* Console.log("")
    yield* Console.log("Prompt prefix:")
    yield* Console.log(persona.prompt_prefix)
  }),
)

// --- seed ---

const seedFile = Options.file("file").pipe(Options.optional)

const seedCommand = Command.make("seed", { file: seedFile }, ({ file }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const filePath = Option.getOrElse(file, () => "specs/team/personas.md")

    // Read and parse the markdown file
    const { readFileSync } = yield* Effect.sync(() => require("node:fs"))
    let content: string
    try {
      content = readFileSync(filePath, "utf-8")
    } catch {
      yield* Console.error(`Cannot read file: ${filePath}`)
      return
    }

    const { personas, reviewRules } = parsePersonasMarkdown(content)

    if (personas.length === 0) {
      yield* Console.error("No personas found in the file.")
      return
    }

    yield* Console.log(`Parsed ${personas.length} personas and ${reviewRules.length} review rules from ${filePath}`)

    const result = yield* kernel.post("/api/personas/seed", {
      personas,
      review_rules: reviewRules,
    }, SeedResult)

    yield* Console.log(`Seeded: ${result.created} created, ${result.updated} updated`)
  }),
)

// --- markdown parser ---

interface ParsedPersona {
  id: string
  name: string
  focus: string
  prompt_prefix: string
  owns: string
  review_focus: string
  pushes_back: string
  tools: string[]
  key_specs: string[]
  source_hash: string
}

interface ParsedReviewRule {
  id: string
  pr_type: string
  persona_ids: string[]
}

function parsePersonasMarkdown(content: string): {
  personas: ParsedPersona[]
  reviewRules: ParsedReviewRule[]
} {
  const personas: ParsedPersona[] = []
  const reviewRules: ParsedReviewRule[] = []

  // Split on persona headings: ## N. Name
  const sections = content.split(/^## \d+\.\s+/m).filter(Boolean)

  const idMap: Record<string, string> = {
    "principal fullstack engineer": "engineer",
    "product manager": "pm",
    "ux specialist": "ux",
    "qa engineer": "qa",
    "devsecops engineer": "devsecops",
    "security expert": "security",
    "tech lead": "tech-lead",
  }

  for (const section of sections) {
    const lines = section.split("\n")
    const nameLine = lines[0]?.trim()
    if (!nameLine) continue

    const id = idMap[nameLine.toLowerCase()] || nameLine.toLowerCase().replace(/\s+/g, "-")

    // Skip non-persona sections (like "How Personas Work Together")
    if (!Object.values(idMap).includes(id)) continue

    const focus = extractAfter(section, "**Focus**:") || ""
    const owns = extractTableValue(section, "Owns") || ""
    const reviewFocus = extractTableValue(section, "Reviews for") || ""
    const pushesBack = extractTableValue(section, "Pushes back when") || ""
    const toolsStr = extractTableValue(section, "Tools") || ""
    const specsStr = extractTableValue(section, "Key specs") || ""

    const tools = toolsStr.split(",").map(t => t.replace(/`/g, "").trim()).filter(Boolean)
    const keySpecs = specsStr.split(",").map(s => s.replace(/`/g, "").trim()).filter(Boolean)

    // Extract prompt prefix from blockquote
    const promptMatch = section.match(/Prompt prefix:\s*\n>\s*(.+)/s)
    const promptPrefix = promptMatch ? promptMatch[1].trim() : ""

    // Simple hash for idempotent seeding
    const sourceHash = simpleHash(section)

    personas.push({
      id, name: nameLine, focus, prompt_prefix: promptPrefix,
      owns, review_focus: reviewFocus, pushes_back: pushesBack,
      tools, key_specs: keySpecs, source_hash: sourceHash,
    })
  }

  // Parse review rules from "Multi-Persona Review" table
  const reviewSection = content.match(/### Multi-Persona Review[\s\S]*?\|[\s\S]*?(?=###|$)/)
  if (reviewSection) {
    const tableRows = reviewSection[0].match(/\|[^|]+\|[^|]+\|/g) || []
    for (const row of tableRows) {
      const cells = row.split("|").map(c => c.trim()).filter(Boolean)
      if (cells.length >= 2 && !cells[0].includes("PR Type") && !cells[0].includes("---")) {
        const prType = cells[0].toLowerCase().replace(/\s+/g, "_")
        const personaNames = cells[1].split(",").map(n => n.trim().toLowerCase())
        const personaIds = personaNames.map(n => {
          const entry = Object.entries(idMap).find(([key]) => n.includes(key.split(" ")[0]))
          return entry ? entry[1] : n.replace(/\s+/g, "-")
        })
        reviewRules.push({
          id: `rule-${prType}`,
          pr_type: prType,
          persona_ids: personaIds,
        })
      }
    }
  }

  return { personas, reviewRules }
}

function extractAfter(text: string, marker: string): string | undefined {
  const idx = text.indexOf(marker)
  if (idx === -1) return undefined
  const rest = text.substring(idx + marker.length)
  const line = rest.split("\n")[0]
  return line?.trim()
}

function extractTableValue(text: string, key: string): string | undefined {
  const regex = new RegExp(`\\*\\*${key}\\*\\*\\s*\\|\\s*(.+?)\\s*\\|`, "m")
  const match = text.match(regex)
  return match ? match[1].trim() : undefined
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return Math.abs(hash).toString(16)
}

// --- compose ---

export const personaCommand = Command.make("persona").pipe(
  Command.withSubcommands([listCommand, getCommand, seedCommand]),
)
