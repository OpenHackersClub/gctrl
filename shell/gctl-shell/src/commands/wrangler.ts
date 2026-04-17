/**
 * gctl wrangler — Cloudflare Workers integration via kernel driver-wrangler.
 *
 * Routes through the kernel HTTP API (/api/wrangler/*), which delegates to the
 * native `wrangler` CLI. The shell has no direct knowledge of wrangler or the
 * Cloudflare API.
 */
import { Command } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"
import { makeExecCommand } from "./cli-exec"

export const WranglerAccount = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
})
export type WranglerAccount = typeof WranglerAccount.Type

export const WranglerWhoami = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  accounts: Schema.Array(WranglerAccount),
  raw: Schema.String,
})
export type WranglerWhoami = typeof WranglerWhoami.Type

const whoamiCommand = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const result = yield* kernel.get("/api/wrangler/whoami", WranglerWhoami)

    yield* Console.log(`Email:    ${result.email ?? "(not logged in)"}`)
    if (result.accounts.length === 0) {
      yield* Console.log("Accounts: (none)")
      return
    }
    yield* Console.log(`Accounts:`)
    yield* Console.log(`  ${"Name".padEnd(32)} ID`)
    yield* Console.log(`  ${"-".repeat(64)}`)
    for (const acc of result.accounts) {
      yield* Console.log(`  ${acc.name.slice(0, 30).padEnd(32)} ${acc.id}`)
    }
  })
)

const execCommand = makeExecCommand("/api/wrangler/exec")

export const wranglerCommand = Command.make("wrangler").pipe(
  Command.withSubcommands([whoamiCommand, execCommand])
)
