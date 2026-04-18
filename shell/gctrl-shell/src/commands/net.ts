/**
 * net — web scraping commands.
 *
 * Static fetch/crawl/list/show/compact delegate to the gctrl Rust binary.
 * Browser-mode fetch routes through the kernel HTTP API
 * (/api/net/fetch, which dispatches to Cloudflare Browser Rendering).
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { execFilePromise } from "../lib/exec"
import { KernelClient } from "../services/KernelClient"

const GCTL_BIN = "gctrl"

const PageContent = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  word_count: Schema.Number,
  status: Schema.Number,
})

const runGctl = (args: string[]) =>
  Effect.gen(function* () {
    const result = yield* execFilePromise(GCTL_BIN, args, process.cwd())
    if (!result.ok) {
      yield* Console.error(result.output || `gctrl ${args[0]} failed`)
      return yield* Effect.fail(new Error(`gctrl ${args[0]} failed`))
    }
    if (result.output) yield* Console.log(result.output)
  }).pipe(
    Effect.catchAll((e) =>
      Console.error(`Error: ${e}. Is the gctrl Rust binary installed? (cargo install gctrl)`)
    )
  )

// --- fetch ---

const fetchUrl = Args.text({ name: "url" })
const renderMode = Options.choice("render", ["static", "browser"]).pipe(
  Options.withDefault("static" as const),
  Options.withDescription("Render backend: static (reqwest) | browser (Cloudflare Browser Rendering)")
)
const waitFor = Options.text("wait-for").pipe(
  Options.optional,
  Options.withDescription("CSS selector to wait for (browser render only)")
)

const fetchCommand = Command.make(
  "fetch",
  { url: fetchUrl, render: renderMode, waitFor },
  ({ url, render, waitFor }) =>
    render === "browser"
      ? Effect.gen(function* () {
          const kernel = yield* KernelClient
          const body: Record<string, unknown> = {
            url,
            render: { kind: "browser", wait_for: Option.getOrUndefined(waitFor) },
          }
          const page = yield* kernel.post("/api/net/fetch", body, PageContent)
          yield* Console.log(`# ${page.title}`)
          yield* Console.log(`<!-- url: ${page.url}  words: ${page.word_count}  status: ${page.status} -->`)
          yield* Console.log("")
          yield* Console.log(page.markdown)
        })
      : runGctl(["net", "fetch", url])
)

// --- crawl ---

const crawlUrl = Args.text({ name: "url" })
const depth = Options.integer("depth").pipe(Options.withDefault(3))
const maxPages = Options.integer("max-pages").pipe(Options.withDefault(50))

const crawlCommand = Command.make(
  "crawl",
  { url: crawlUrl, depth, maxPages },
  ({ url, depth, maxPages }) =>
    runGctl(["net", "crawl", url, "--depth", String(depth), "--max-pages", String(maxPages)])
)

// --- list ---

const listCommand = Command.make("list", {}, () =>
  runGctl(["net", "list"])
)

// --- show ---

const showDomain = Args.text({ name: "domain" })
const showPage = Options.text("page").pipe(
  Options.optional,
  Options.withDescription("Specific page file to display")
)

const showCommand = Command.make(
  "show",
  { domain: showDomain, page: showPage },
  ({ domain, page }) => {
    const args = ["net", "show", domain]
    if (Option.isSome(page)) args.push("--page", page.value)
    return runGctl(args)
  }
)

// --- compact ---

const compactDomain = Args.text({ name: "domain" })

const compactCommand = Command.make(
  "compact",
  { domain: compactDomain },
  ({ domain }) => runGctl(["net", "compact", domain])
)

// --- net (parent) ---

export const netCommand = Command.make("net").pipe(
  Command.withSubcommands([fetchCommand, crawlCommand, listCommand, showCommand, compactCommand])
)
