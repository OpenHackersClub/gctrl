import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

// --- schemas (mirroring persona.ts and team.ts) ---

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

const TeamPersonaDefinition = Schema.Struct({
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
  personas: Schema.Array(TeamPersonaDefinition),
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

// --- mock data ---

const mockPersona = {
  id: "engineer",
  name: "Principal Fullstack Engineer",
  focus: "Architecture, code quality",
  prompt_prefix: "You are a Principal...",
  owns: "Kernel crates, shell",
  review_focus: "Hexagonal boundaries",
  pushes_back: "Shortcuts bypass shell",
  tools: ["cargo build", "cargo test"],
  key_specs: ["specs/architecture/"],
  source_hash: "abc123",
}

const mockSeedResult = { created: 7, updated: 0 }

const mockRecommendation = {
  personas: [
    {
      id: "engineer",
      name: "Principal Fullstack Engineer",
      focus: "Architecture, code quality",
      prompt_prefix: "You are a Principal...",
      owns: "Kernel crates, shell",
      review_focus: "Hexagonal boundaries",
      pushes_back: "Shortcuts bypass shell",
      tools: ["cargo build", "cargo test"],
      key_specs: ["specs/architecture/"],
    },
  ],
  rationale: "Matched review rule 'new_kernel_primitive'",
}

const mockRenderResult = {
  agents: [
    {
      persona_id: "engineer",
      name: "Principal Fullstack Engineer",
      prompt: "You are a Principal Fullstack Engineer...",
    },
  ],
}

const MockLayer = createMockKernelClient(
  {
    "/api/personas": [mockPersona],
    "/api/personas/engineer": mockPersona,
  },
  {
    "/api/personas/seed": mockSeedResult,
    "/api/team/recommend": mockRecommendation,
    "/api/team/render": mockRenderResult,
  }
)

const EmptyMockLayer = createMockKernelClient(
  {
    "/api/personas": [],
  },
  {}
)

describe("Persona commands (via KernelClient)", () => {
  it("persona list returns array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/personas", PersonaList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("engineer")
    expect(result[0].name).toBe("Principal Fullstack Engineer")
  })

  it("persona get returns single", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/personas/engineer", PersonaDefinition)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("engineer")
    expect(result.focus).toBe("Architecture, code quality")
    expect(result.tools).toEqual(["cargo build", "cargo test"])
    expect(result.key_specs).toEqual(["specs/architecture/"])
    expect(result.source_hash).toBe("abc123")
  })

  it("persona seed posts parsed data", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/personas/seed",
        {
          personas: [mockPersona],
          review_rules: [],
        },
        SeedResult
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.created).toBe(7)
    expect(result.updated).toBe(0)
  })

  it("team recommend returns recommendation", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/team/recommend",
        { labels: ["kernel"], pr_type: "new_kernel_primitive" },
        TeamRecommendation
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.rationale).toBe("Matched review rule 'new_kernel_primitive'")
    expect(result.personas).toHaveLength(1)
    expect(result.personas[0].id).toBe("engineer")
    expect(result.personas[0].name).toBe("Principal Fullstack Engineer")
  })

  it("team render returns rendered prompts", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/team/render",
        { persona_ids: ["engineer"] },
        TeamRenderResult
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].persona_id).toBe("engineer")
    expect(result.agents[0].name).toBe("Principal Fullstack Engineer")
    expect(result.agents[0].prompt).toBe("You are a Principal Fullstack Engineer...")
  })

  it("empty persona list", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/personas", PersonaList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyMockLayer)))
    expect(result).toHaveLength(0)
  })
})
