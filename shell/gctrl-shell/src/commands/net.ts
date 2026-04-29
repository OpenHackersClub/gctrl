/**
 * net — web tooling.
 *
 * - `fetch/crawl/list/show/compact` — delegate to the gctrl Rust binary
 *   (filesystem-backed spider).
 * - `fetch --render browser` — kernel HTTP /api/net/fetch (Cloudflare Browser).
 * - `setup/logs/stats` — kernel MITM proxy (capture HTTP traffic from agents).
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { ExecError } from "../errors"
import { execFilePromise } from "../lib/exec"
import { KernelClient } from "../services/KernelClient"

const GCTRL_BIN = "gctrl"

const PageContent = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  word_count: Schema.Number,
  status: Schema.Number,
})

const runGctl = (args: string[]) =>
  Effect.gen(function* () {
    const result = yield* execFilePromise(GCTRL_BIN, args, process.cwd())
    if (!result.ok) {
      yield* Console.error(result.output || `gctrl ${args[0]} failed`)
      return yield* Effect.fail(
        new ExecError({
          message: `gctrl ${args[0]} failed`,
          bin: GCTRL_BIN,
          args,
          output: result.output,
        })
      )
    }
    if (result.output) yield* Console.log(result.output)
  }).pipe(
    Effect.catchTag("ExecError", (e) =>
      Console.error(
        `Error: ${e.bin} ${e.args.join(" ")} failed. Is the gctrl Rust binary installed? (cargo install gctrl)`
      )
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

// --- proxy: setup ---
//
// Pure stdout — prints HTTP_PROXY/HTTPS_PROXY/NODE_EXTRA_CA_CERTS env block
// plus the macOS keychain trust command. Does not call the kernel, so it
// works offline.

const PROXY_PORT_DEFAULT = 8080

const setupCommand = Command.make("setup", {}, () =>
  Effect.gen(function* () {
    const port = process.env.GCTRL_PROXY_PORT ?? String(PROXY_PORT_DEFAULT)
    const home = process.env.HOME ?? "~"
    const caPath = `${home}/.local/share/gctrl/proxy/ca/ca.cer`
    yield* Console.log("# Route agent HTTP traffic through the gctrl proxy.")
    yield* Console.log("# Add the following to ~/.zshrc (or your shell rc):")
    yield* Console.log("")
    yield* Console.log(`export HTTP_PROXY=http://127.0.0.1:${port}`)
    yield* Console.log(`export HTTPS_PROXY=http://127.0.0.1:${port}`)
    yield* Console.log(`export NODE_EXTRA_CA_CERTS=${caPath}`)
    yield* Console.log("export NO_PROXY=localhost,127.0.0.1,::1")
    yield* Console.log("")
    yield* Console.log("# Trust the proxy CA in your login keychain (SSL only):")
    yield* Console.log(
      `security add-trusted-cert -k ~/Library/Keychains/login.keychain-db -p ssl ${caPath}`
    )
    yield* Console.log("")
    yield* Console.log(
      "# Start the daemon with --proxy:  gctrld serve --proxy"
    )
  })
)

// --- proxy: logs ---

const TrafficRow = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.String,
  method: Schema.String,
  url: Schema.String,
  host: Schema.String,
  status_code: Schema.Number,
  request_size_bytes: Schema.Number,
  response_size_bytes: Schema.Number,
  duration_ms: Schema.Number,
  session_id: Schema.NullOr(Schema.String),
})
const TrafficRows = Schema.Array(TrafficRow)

const logsHost = Options.text("host").pipe(
  Options.optional,
  Options.withDescription("Filter by hostname (substring match)")
)
const logsSince = Options.text("since").pipe(
  Options.optional,
  Options.withDescription("Lookback window: 30s | 5m | 1h | 2d")
)
const logsLimit = Options.integer("limit").pipe(
  Options.withDefault(50),
  Options.withDescription("Max rows")
)
const logsFormat = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table" as const)
)

const logsCommand = Command.make(
  "logs",
  { host: logsHost, since: logsSince, limit: logsLimit, format: logsFormat },
  ({ host, since, limit, format }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      if (Option.isSome(host)) params.set("host", host.value)
      if (Option.isSome(since)) params.set("since", since.value)
      params.set("limit", String(limit))
      const path = `/api/net/logs?${params.toString()}`
      const rows = yield* kernel.get(path, TrafficRows)
      if (format === "json") {
        yield* Console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        yield* Console.log("(no traffic — start the daemon with --proxy and route an agent through it)")
        return
      }
      for (const r of rows) {
        const ts = r.timestamp.replace("T", " ").replace(/\..*$/, "")
        yield* Console.log(
          `${ts}  ${String(r.status_code).padEnd(3)}  ${r.method.padEnd(6)}  ${r.duration_ms.toString().padStart(5)}ms  ${r.url}`
        )
      }
    })
)

// --- proxy: stats ---

const TrafficStats = Schema.Struct({
  total_requests: Schema.Number,
  total_request_bytes: Schema.Number,
  total_response_bytes: Schema.Number,
  by_host: Schema.Array(Schema.Tuple(Schema.String, Schema.Number)),
  by_status: Schema.Array(Schema.Tuple(Schema.Number, Schema.Number)),
})

const statsFormat = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table" as const)
)

const statsCommand = Command.make("stats", { format: statsFormat }, ({ format }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const stats = yield* kernel.get("/api/net/stats", TrafficStats)
    if (format === "json") {
      yield* Console.log(JSON.stringify(stats, null, 2))
      return
    }
    yield* Console.log(`total requests:   ${stats.total_requests}`)
    yield* Console.log(`bytes sent:       ${stats.total_request_bytes}`)
    yield* Console.log(`bytes received:   ${stats.total_response_bytes}`)
    yield* Console.log("")
    yield* Console.log("by host:")
    for (const [host, count] of stats.by_host) {
      yield* Console.log(`  ${count.toString().padStart(6)}  ${host}`)
    }
    yield* Console.log("")
    yield* Console.log("by status:")
    for (const [status, count] of stats.by_status) {
      yield* Console.log(`  ${count.toString().padStart(6)}  ${status}`)
    }
  })
)

// --- net (parent) ---

export const netCommand = Command.make("net").pipe(
  Command.withSubcommands([
    fetchCommand,
    crawlCommand,
    listCommand,
    showCommand,
    compactCommand,
    setupCommand,
    logsCommand,
    statsCommand,
  ])
)
