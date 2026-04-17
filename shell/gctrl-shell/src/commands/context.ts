import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

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

const ContextEntryList = Schema.Array(ContextEntry)

const ContextStats = Schema.Struct({
  total_entries: Schema.Number,
  total_words: Schema.Number,
  by_kind: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
  by_source: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
})

// --- options ---

const kind = Options.text("kind").pipe(
  Options.optional,
  Options.withDescription("Filter by kind (document, config, snapshot)")
)
const tag = Options.text("tag").pipe(
  Options.optional,
  Options.withDescription("Filter by tag")
)
const search = Options.text("search").pipe(
  Options.optional,
  Options.withDescription("Full-text search")
)
const limit = Options.integer("limit").pipe(Options.withDefault(100))
const contextId = Args.text({ name: "id" })

// --- subcommands ---

const listCommand = Command.make(
  "list",
  { kind, tag, search, limit },
  ({ kind, tag, search, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (Option.isSome(kind)) params.set("kind", kind.value)
      if (Option.isSome(tag)) params.set("tag", tag.value)
      if (Option.isSome(search)) params.set("search", search.value)

      const entries = yield* kernel.get(`/api/context?${params.toString()}`, ContextEntryList)

      if (entries.length === 0) {
        yield* Console.log("No context entries found.")
        return
      }

      yield* Console.log(`${"ID".padEnd(10)} ${"Kind".padEnd(12)} ${"Title".padEnd(35)} ${"Words".padEnd(8)} Tags`)
      yield* Console.log("-".repeat(80))
      for (const e of entries) {
        yield* Console.log(
          `${e.id.slice(0, 8).padEnd(10)} ${e.kind.padEnd(12)} ${e.title.slice(0, 33).padEnd(35)} ${String(e.word_count).padEnd(8)} ${e.tags.join(", ")}`
        )
      }
    })
)

const addPath = Options.text("path").pipe(Options.withDescription("Context path"))
const addTitle = Options.text("title").pipe(Options.withDescription("Context title"))
const addContent = Options.text("content").pipe(Options.withDescription("Content body"))
const addKind = Options.text("kind").pipe(
  Options.withDefault("document"),
  Options.withDescription("Kind (document, config, snapshot)")
)

const addCommand = Command.make(
  "add",
  { path: addPath, title: addTitle, content: addContent, kind: addKind },
  ({ path, title, content, kind }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const entry = yield* kernel.post(
        "/api/context",
        { path, title, content, kind },
        ContextEntry
      )
      yield* Console.log(`Context added: ${entry.id} — ${entry.title}`)
    })
)

const showCommand = Command.make(
  "show",
  { id: contextId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const entry = yield* kernel.get(`/api/context/${id}`, ContextEntry)
      yield* Console.log(`ID:      ${entry.id}`)
      yield* Console.log(`Kind:    ${entry.kind}`)
      yield* Console.log(`Path:    ${entry.path}`)
      yield* Console.log(`Title:   ${entry.title}`)
      yield* Console.log(`Source:  ${entry.source_type}`)
      yield* Console.log(`Words:   ${entry.word_count}`)
      yield* Console.log(`Tags:    ${entry.tags.join(", ") || "(none)"}`)
      yield* Console.log(`Created: ${entry.created_at}`)
      yield* Console.log(`Updated: ${entry.updated_at}`)
    })
)

const contentCommand = Command.make(
  "content",
  { id: contextId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const text = yield* kernel.getText(`/api/context/${id}/content`)
      yield* Console.log(text)
    })
)

const removeCommand = Command.make(
  "remove",
  { id: contextId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete(`/api/context/${id}`)
      yield* Console.log(`Context entry ${id} removed.`)
    })
)

const compactCommand = Command.make(
  "compact",
  { kind, tag },
  ({ kind, tag }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      if (Option.isSome(kind)) params.set("kind", kind.value)
      if (Option.isSome(tag)) params.set("tag", tag.value)
      const qs = params.toString()
      const text = yield* kernel.getText(`/api/context/compact${qs ? `?${qs}` : ""}`)
      yield* Console.log(text)
    })
)

const statsCommand = Command.make("stats", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const s = yield* kernel.get("/api/context/stats", ContextStats)
    yield* Console.log("Context Statistics")
    yield* Console.log("-".repeat(40))
    yield* Console.log(`Total entries: ${s.total_entries}`)
    yield* Console.log(`Total words:   ${s.total_words}`)
    yield* Console.log("\nBy Kind:")
    for (const [k, v] of s.by_kind) {
      yield* Console.log(`  ${k.padEnd(15)} ${v}`)
    }
    yield* Console.log("\nBy Source:")
    for (const [k, v] of s.by_source) {
      yield* Console.log(`  ${k.padEnd(15)} ${v}`)
    }
  })
)

// --- context (parent) ---

export const contextCommand = Command.make("context").pipe(
  Command.withSubcommands([
    listCommand,
    addCommand,
    showCommand,
    contentCommand,
    removeCommand,
    compactCommand,
    statsCommand,
  ])
)
