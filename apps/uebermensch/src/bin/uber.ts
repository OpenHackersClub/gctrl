import { Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
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
import { MODES, resolveMode } from "../lib/mode.js"

// `--mode` resolves adapter wiring for the full process.  Commands do not read
// it yet — slice 7 will replace per-command `--llm` flag logic with a
// `buildModeLayer(mode)` factory.  The flag is registered on the root command
// now so that: (a) `--help` documents it, and (b) the env-var fallback is
// validated at startup rather than mid-pipeline.
const modeOpt = Options.choice("mode", [...MODES]).pipe(
  Options.withDescription(
    "Adapter wiring mode: 'local-kernel' (default, routes LLM through gctrl kernel), 'local-direct' (Anthropic SDK, no daemon), 'cloud-only' (Cloudflare AI Gateway).",
  ),
  Options.withDefault("local-kernel" as const),
)

const root = Command.make("uber", { modeOpt }).pipe(
  Command.withSubcommands([vault, profile, brief, ingest, send, report, prompts, calendar, events, timebox, sinkin, sync, runDaily, schedule]),
  Command.withDescription("uebermensch Chief-of-Staff CLI"),
)

const cli = Command.run(root, { name: "uber", version: "0.1.0" })

// Resolve UBER_MODE at startup so a bad env var surfaces immediately rather
// than after the first LLM call.  The --mode flag on the root command takes
// precedence in a future slice; for now the env var is the only source.
const mode = resolveMode()

Effect.zipRight(
  Console.log(`mode: ${mode}`),
  cli(process.argv),
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
