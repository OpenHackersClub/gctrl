/**
 * gctrl search — web / news / image search via kernel Brave Search driver.
 *
 * Routes through /api/search/* — the kernel daemon holds BRAVE_SEARCH_API_KEY.
 * The shell never calls search.brave.com directly.
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

export const SearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  description: Schema.String,
  age: Schema.optional(Schema.String),
})

export const SearchResponse = Schema.Struct({
  query: Schema.String,
  kind: Schema.String,
  results: Schema.Array(SearchResult),
})

const query = Args.text({ name: "query" })
const count = Options.integer("count").pipe(
  Options.withAlias("n"),
  Options.optional,
  Options.withDescription("Max results (Brave default 20)")
)
const country = Options.text("country").pipe(
  Options.optional,
  Options.withDescription("ISO country code, e.g. US")
)
const freshness = Options.text("freshness").pipe(
  Options.optional,
  Options.withDescription("pd | pw | pm | py or custom range")
)

const makeSearchCmd = (name: string, path: string, label: string) =>
  Command.make(
    name,
    { query, count, country, freshness },
    ({ query: q, count, country, freshness }) =>
      Effect.gen(function* () {
        const kernel = yield* KernelClient
        const body: Record<string, unknown> = { q }
        if (Option.isSome(count)) body.count = count.value
        if (Option.isSome(country)) body.country = country.value
        if (Option.isSome(freshness)) body.freshness = freshness.value

        const resp = yield* kernel.post(path, body, SearchResponse)

        if (resp.results.length === 0) {
          yield* Console.log(`No ${label} results for "${resp.query}"`)
          return
        }

        yield* Console.log(`${label} results for "${resp.query}" (${resp.results.length}):`)
        yield* Console.log("")
        for (const [i, r] of resp.results.entries()) {
          const age = r.age ? `  ${r.age}` : ""
          yield* Console.log(`${i + 1}. ${r.title}${age}`)
          yield* Console.log(`   ${r.url}`)
          if (r.description) {
            const desc = r.description.replace(/<\/?strong>/g, "").slice(0, 200)
            yield* Console.log(`   ${desc}`)
          }
          yield* Console.log("")
        }
      })
  )

const webCommand = makeSearchCmd("web", "/api/search/web", "Web")
const newsCommand = makeSearchCmd("news", "/api/search/news", "News")
const imagesCommand = makeSearchCmd("images", "/api/search/images", "Image")

export const searchCommand = Command.make("search").pipe(
  Command.withSubcommands([webCommand, newsCommand, imagesCommand])
)
