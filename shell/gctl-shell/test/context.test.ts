import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

const mockEntries = [
  {
    id: "ctx-1",
    kind: "document",
    path: "docs/architecture.md",
    title: "Architecture Overview",
    source_type: "human",
    word_count: 1500,
    tags: ["arch", "core"],
    created_at: "2026-03-28T10:00:00Z",
    updated_at: "2026-03-30T10:00:00Z",
  },
  {
    id: "ctx-2",
    kind: "config",
    path: "config/kernel.toml",
    title: "Kernel Configuration",
    source_type: "auto",
    word_count: 200,
    tags: ["config"],
    created_at: "2026-03-29T10:00:00Z",
    updated_at: "2026-03-30T10:00:00Z",
  },
]

const mockStats = {
  total_entries: 25,
  total_words: 45000,
  by_kind: [["document", 20], ["config", 5]],
  by_source: [["human", 18], ["auto", 7]],
}

const MockLayer = createMockKernelClient(
  {
    "/api/context": mockEntries,
    "/api/context/ctx-1": mockEntries[0],
    "/api/context/stats": mockStats,
  },
  {
    "/api/context": mockEntries[0],
  },
  {
    "/api/context/ctx-1/content": "# Architecture\n\nThis document describes the system architecture.",
    "/api/context/compact": "# Compact Context\n\nAll documents merged.",
  }
)

const ContextEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  title: Schema.String,
  source_type: Schema.String,
  word_count: Schema.Number,
  tags: Schema.Array(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

describe("Context commands (via KernelClient)", () => {
  it("list returns context entries", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/context?limit=100", Schema.Array(ContextEntry))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe("Architecture Overview")
    expect(result[1].kind).toBe("config")
  })

  it("show returns single entry", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/context/ctx-1", ContextEntry)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("ctx-1")
    expect(result.tags).toContain("arch")
  })

  it("content returns plain text", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/ctx-1/content")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toContain("Architecture")
    expect(result).toContain("system architecture")
  })

  it("add upserts entry via POST", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/context", {
        path: "docs/new.md",
        title: "New Doc",
        content: "Hello",
        kind: "document",
      }, ContextEntry)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("ctx-1")
  })

  it("remove deletes entry", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/context/ctx-1")
    })

    await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
  })

  it("compact returns merged text", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.getText("/api/context/compact")
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toContain("Compact Context")
  })

  it("stats returns summary", async () => {
    const ContextStats = Schema.Struct({
      total_entries: Schema.Number,
      total_words: Schema.Number,
      by_kind: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
      by_source: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/context/stats", ContextStats)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.total_entries).toBe(25)
    expect(result.total_words).toBe(45000)
    expect(result.by_kind).toHaveLength(2)
  })
})
