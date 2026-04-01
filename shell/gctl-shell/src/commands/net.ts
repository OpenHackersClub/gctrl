/**
 * net — web scraping commands.
 *
 * Delegates to the gctl Rust binary since gctl-net has no HTTP API routes.
 * These are thin subprocess wrappers until kernel HTTP routes are added.
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { execFilePromise } from "../lib/exec"

const GCTL_BIN = "gctl"

const runGctl = (args: string[]) =>
  Effect.gen(function* () {
    const result = yield* execFilePromise(GCTL_BIN, args, process.cwd())
    if (!result.ok) {
      yield* Console.error(result.output || `gctl ${args[0]} failed`)
      return yield* Effect.fail(new Error(`gctl ${args[0]} failed`))
    }
    if (result.output) yield* Console.log(result.output)
  }).pipe(
    Effect.catchAll((e) =>
      Console.error(`Error: ${e}. Is the gctl Rust binary installed? (cargo install gctl)`)
    )
  )

// --- fetch ---

const fetchUrl = Args.text({ name: "url" })

const fetchCommand = Command.make(
  "fetch",
  { url: fetchUrl },
  ({ url }) => runGctl(["net", "fetch", url])
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
