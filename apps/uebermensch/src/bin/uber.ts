import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { brief } from "../commands/brief.js"
import { ingest } from "../commands/ingest.js"
import { profile } from "../commands/profile-validate.js"
import { vault } from "../commands/vault.js"

const root = Command.make("uber").pipe(
  Command.withSubcommands([vault, profile, brief, ingest]),
  Command.withDescription("uebermensch Chief-of-Staff CLI"),
)

const cli = Command.run(root, { name: "uber", version: "0.1.0" })

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
