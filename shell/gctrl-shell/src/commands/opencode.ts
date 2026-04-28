/**
 * opencode — integration with sst/opencode running against LMStudio.
 *
 * Read commands filter /api/sessions for opencode-attributed rows
 * (agent_name="opencode", created_by=otel_ingest). The `run` command
 * is a launcher that mints a session UUID, exports OTel + relay env
 * vars, and exec's opencode with the user's args.
 *
 * Spec: vault/specs/implementation/opencode-integration.md
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { KernelClient } from "../services/KernelClient"

const OPENCODE_AGENT_NAME = "opencode"
const DEFAULT_RELAY_PORT = 4319
const DEFAULT_KERNEL_PORT = 4318

// --- schemas ---

const Session = Schema.Struct({
  id: Schema.String,
  agent_name: Schema.String,
  status: Schema.String,
  started_at: Schema.String,
  total_cost_usd: Schema.Number,
  total_input_tokens: Schema.Number,
  total_output_tokens: Schema.Number,
})
const SessionList = Schema.Array(Session)

const Span = Schema.Struct({
  span_id: Schema.String,
  operation_name: Schema.String,
  span_type: Schema.String,
  model: Schema.NullOr(Schema.String),
  cost_usd: Schema.Number,
  duration_ms: Schema.NullOr(Schema.Number),
  status: Schema.String,
})
const SpanList = Schema.Array(Span)

const PromptTurn = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  turn_ordinal: Schema.Number,
  role: Schema.String,
  content: Schema.String,
  fingerprint: Schema.String,
  tokens: Schema.NullOr(Schema.Number),
})
const PromptList = Schema.Struct({
  session_id: Schema.String,
  count: Schema.Number,
  prompts: Schema.Array(PromptTurn),
})

// --- pure helpers (testable without subprocess) ---

export interface RunEnvInputs {
  readonly sessionId: string
  readonly kernelPort: number
  readonly relayPort: number
  readonly upstream: string
}

/**
 * Build the env vars opencode + the relay need. Pure function so unit
 * tests can assert on the shape without spawning anything.
 */
export const buildRunEnv = (
  inputs: RunEnvInputs,
  baseEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => ({
  ...baseEnv,
  OTEL_SERVICE_NAME: OPENCODE_AGENT_NAME,
  OTEL_RESOURCE_ATTRIBUTES: `service.name=${OPENCODE_AGENT_NAME},session.id=${inputs.sessionId}`,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://localhost:${inputs.kernelPort}/v1/traces`,
  OPENCODE_SESSION_ID: inputs.sessionId,
  OPENCODE_LLM_UPSTREAM: inputs.upstream,
  GCTRL_RELAY_PORT: String(inputs.relayPort),
})

// --- list ---

const limit = Options.integer("limit").pipe(Options.withDefault(20))

const sessionsCommand = Command.make(
  "sessions",
  { limit },
  ({ limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("agent_name", OPENCODE_AGENT_NAME)
      params.set("limit", String(limit))

      const sessions = yield* kernel.get(
        `/api/sessions?${params.toString()}`,
        SessionList
      )

      if (sessions.length === 0) {
        yield* Console.log("No opencode sessions yet. Run `gctrl opencode run -- ...` to create one.")
        return
      }

      yield* Console.log(`${"ID".padEnd(40)} ${"Status".padEnd(10)} ${"Cost".padEnd(10)} Started`)
      yield* Console.log("-".repeat(85))
      for (const s of sessions) {
        yield* Console.log(
          `${s.id.padEnd(40)} ${s.status.padEnd(10)} $${s.total_cost_usd.toFixed(4).padEnd(9)} ${s.started_at}`
        )
      }
    })
)

// --- last ---

const lastCommand = Command.make("last", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const params = new URLSearchParams()
    params.set("agent_name", OPENCODE_AGENT_NAME)
    params.set("limit", "1")

    const sessions = yield* kernel.get(
      `/api/sessions?${params.toString()}`,
      SessionList
    )

    if (sessions.length === 0) {
      yield* Console.log("No opencode sessions yet.")
      return
    }

    const last = sessions[0]
    yield* Console.log(`Session: ${last.id}`)
    yield* Console.log(`Status:  ${last.status}`)
    yield* Console.log(`Started: ${last.started_at}`)
    yield* Console.log(`Cost:    $${last.total_cost_usd.toFixed(4)}`)
    yield* Console.log(`Tokens:  ${last.total_input_tokens} in / ${last.total_output_tokens} out`)
    yield* Console.log("")

    const spans = yield* kernel.get(`/api/sessions/${last.id}/spans`, SpanList)
    if (spans.length > 0) {
      yield* Console.log(`Spans (${spans.length}):`)
      for (const sp of spans.slice(0, 10)) {
        const dur = sp.duration_ms != null ? `${sp.duration_ms}ms` : "-"
        const model = sp.model ?? "-"
        yield* Console.log(`  ${sp.operation_name.padEnd(28)} ${model.padEnd(20)} ${dur.padEnd(8)} $${sp.cost_usd.toFixed(4)}`)
      }
      if (spans.length > 10) yield* Console.log(`  ... ${spans.length - 10} more`)
      yield* Console.log("")
    }

    const promptResp = yield* kernel.get(
      `/api/sessions/${last.id}/prompts`,
      PromptList
    )
    if (promptResp.count === 0) {
      yield* Console.log("(no prompt bodies captured)")
      return
    }
    yield* Console.log(`Prompt turns (${promptResp.count}):`)
    for (const turn of promptResp.prompts) {
      const tokens = turn.tokens != null ? ` (${turn.tokens}t)` : ""
      yield* Console.log(`  [${turn.turn_ordinal}] ${turn.role}${tokens}: ${truncate(turn.content, 200)}`)
    }
  })
)

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

// --- run (launcher) ---

const upstreamOpt = Options.text("upstream").pipe(
  Options.withDefault("http://127.0.0.1:1234/v1/chat/completions"),
  Options.withDescription("LMStudio (or other OpenAI-compat) upstream URL")
)
const relayPortOpt = Options.integer("relay-port").pipe(
  Options.withDefault(DEFAULT_RELAY_PORT),
  Options.withDescription("gctrl-proxy LLM relay port")
)
const kernelPortOpt = Options.integer("kernel-port").pipe(
  Options.withDefault(DEFAULT_KERNEL_PORT),
  Options.withDescription("gctrl daemon port (for OTLP /v1/traces)")
)
const opencodeArgs = Args.text({ name: "args" }).pipe(Args.repeated)

const runCommand = Command.make(
  "run",
  { upstream: upstreamOpt, relayPort: relayPortOpt, kernelPort: kernelPortOpt, args: opencodeArgs },
  ({ upstream, relayPort, kernelPort, args }) =>
    Effect.gen(function* () {
      const sessionId = randomUUID()
      const env = buildRunEnv(
        { sessionId, kernelPort, relayPort, upstream },
        process.env
      )

      yield* Console.log(`gctrl opencode: session.id=${sessionId}`)
      yield* Console.log(`  relay  : http://localhost:${relayPort}/v1/chat/completions`)
      yield* Console.log(`  upstream: ${upstream}`)
      yield* Console.log(`  kernel : http://localhost:${kernelPort}`)
      yield* Console.log("")

      const exitCode = yield* Effect.async<number, never>((resume) => {
        const child = spawn("opencode", [...args], { env, stdio: "inherit" })
        child.on("close", (code) => resume(Effect.succeed(code ?? 0)))
        child.on("error", (err) => {
          process.stderr.write(`opencode failed to start: ${err.message}\n`)
          resume(Effect.succeed(127))
        })
      })

      if (exitCode !== 0) {
        yield* Effect.sync(() => process.exit(exitCode))
      }
    })
)

// --- opencode (parent) ---

export const opencodeCommand = Command.make("opencode").pipe(
  Command.withSubcommands([sessionsCommand, lastCommand, runCommand])
)
