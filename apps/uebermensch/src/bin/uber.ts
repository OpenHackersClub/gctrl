import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { brief } from "../commands/brief.js"
import { calendar } from "../commands/calendar.js"
import { events } from "../commands/events.js"
import { ingest } from "../commands/ingest.js"
import { profile } from "../commands/profile-validate.js"
import { prompts } from "../commands/prompts.js"
import { report } from "../commands/report.js"
import { send } from "../commands/send.js"
import { sync } from "../commands/sync.js"
import { timebox } from "../commands/timebox.js"
import { vault } from "../commands/vault.js"

const root = Command.make("uber").pipe(
  Command.withSubcommands([vault, profile, brief, ingest, send, report, prompts, calendar, events, timebox, sync]),
  Command.withDescription("uebermensch Chief-of-Staff CLI"),
)

const cli = Command.run(root, { name: "uber", version: "0.1.0" })

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
