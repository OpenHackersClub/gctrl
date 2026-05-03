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
import { runDaily } from "../commands/run-daily.js"
import { schedule } from "../commands/schedule.js"
import { send } from "../commands/send.js"
import { sinkin } from "../commands/sinkin.js"
import { sync } from "../commands/sync.js"
import { timebox } from "../commands/timebox.js"
import { vault } from "../commands/vault.js"

// All capabilities (LLM, deliverers, vault sync, secrets) route through the
// gctrl kernel via its HTTP API. The previous `--mode` flag and `UBER_MODE`
// env var are gone — the kernel owns adapter wiring; the app is a thin
// consumer of `/api/llm/*`, `/api/{telegram,discord}/send`, `/api/sync/vault/*`.
const root = Command.make("uber").pipe(
  Command.withSubcommands([vault, profile, brief, ingest, send, report, prompts, calendar, events, timebox, sinkin, sync, runDaily, schedule]),
  Command.withDescription("uebermensch Chief-of-Staff CLI"),
)

const cli = Command.run(root, { name: "uber", version: "0.2.0" })

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
