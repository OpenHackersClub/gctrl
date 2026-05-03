/**
 * `gctrl browser` — drive the kernel `driver-browser` from the CLI.
 *
 * Subcommands:
 *   - health           kernel browser health
 *   - sessions         list active sessions
 *   - acquire [--ttl]  acquire a session, print info
 *   - release <id>     release a session
 *   - report <id>      print observability report (network/console/metrics)
 */
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { BrowserClient } from "../services/BrowserClient"

const idArg = Args.text({ name: "id" })

const healthCmd = Command.make("health", {}, () =>
  Effect.gen(function* () {
    const browser = yield* BrowserClient
    const h = yield* browser.health()
    yield* Console.log(JSON.stringify(h, null, 2))
  })
)

const sessionsCmd = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const browser = yield* BrowserClient
    const list = yield* browser.list()
    yield* Console.log(JSON.stringify(list, null, 2))
  })
)

const ttlOpt = Options.integer("ttl").pipe(
  Options.withDefault(600),
  Options.withDescription("session TTL in seconds (max 3600)")
)

const acquireCmd = Command.make("acquire", { ttl: ttlOpt }, ({ ttl }) =>
  Effect.gen(function* () {
    const browser = yield* BrowserClient
    const info = yield* browser.acquire({ ttlSeconds: ttl })
    yield* Console.log(JSON.stringify(info, null, 2))
  })
)

const releaseCmd = Command.make("release", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    const browser = yield* BrowserClient
    yield* browser.release(id)
    yield* Console.log(`released ${id}`)
  })
)

const reportCmd = Command.make("report", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    const browser = yield* BrowserClient
    const r = yield* browser.report(id)
    yield* Console.log(JSON.stringify(r, null, 2))
  })
)

export const browserCommand = Command.make("browser").pipe(
  Command.withSubcommands([healthCmd, sessionsCmd, acquireCmd, releaseCmd, reportCmd])
)
