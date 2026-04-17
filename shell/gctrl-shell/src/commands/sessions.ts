import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

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

const SessionDetail = Schema.Struct({
  id: Schema.String,
  agent_name: Schema.String,
  status: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  total_cost_usd: Schema.Number,
  total_input_tokens: Schema.Number,
  total_output_tokens: Schema.Number,
})

const Span = Schema.Struct({
  span_id: Schema.String,
  trace_id: Schema.String,
  parent_span_id: Schema.NullOr(Schema.String),
  session_id: Schema.String,
  agent_name: Schema.String,
  operation_name: Schema.String,
  span_type: Schema.String,
  model: Schema.NullOr(Schema.String),
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cost_usd: Schema.Number,
  status: Schema.String,
  started_at: Schema.String,
  duration_ms: Schema.NullOr(Schema.Number),
})
const SpanList = Schema.Array(Span)

const TreeNode = Schema.Struct({
  span_id: Schema.String,
  operation_name: Schema.String,
  span_type: Schema.String,
  status: Schema.String,
  duration_ms: Schema.NullOr(Schema.Number),
  cost_usd: Schema.Number,
})

const TraceTree = Schema.Struct({
  session_id: Schema.String,
  span_count: Schema.Number,
  spans: Schema.Array(TreeNode),
})

const EndResult = Schema.Struct({
  session_id: Schema.String,
  status: Schema.String,
  loops_detected: Schema.Number,
})

const Score = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  value: Schema.Number,
  source: Schema.String,
})
const ScoreList = Schema.Array(Score)

const LoopInfo = Schema.Struct({
  session_id: Schema.String,
  count: Schema.Number,
})

const CostBreakdownEntry = Schema.Struct({
  model: Schema.String,
  cost_usd: Schema.Number,
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  span_count: Schema.Number,
})
const CostBreakdown = Schema.Struct({
  session_id: Schema.String,
  breakdown: Schema.Array(CostBreakdownEntry),
})

// --- shared options ---

const agent = Options.text("agent").pipe(Options.optional)
const status = Options.text("status").pipe(Options.optional)
const limit = Options.integer("limit").pipe(Options.withDefault(20))
const sessionId = Args.text({ name: "session-id" })

// --- list (default) ---

const listCommand = Command.make(
  "list",
  { agent, status, limit },
  ({ agent, status, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (Option.isSome(agent)) params.set("agent", agent.value)
      if (Option.isSome(status)) params.set("status", status.value)

      const sessions = yield* kernel.get(
        `/api/sessions?${params.toString()}`,
        SessionList
      )

      if (sessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log(`${"ID".padEnd(40)} ${"Agent".padEnd(20)} ${"Status".padEnd(12)} ${"Cost".padEnd(10)} Started`)
      yield* Console.log("-".repeat(100))
      for (const s of sessions) {
        yield* Console.log(
          `${s.id.padEnd(40)} ${s.agent_name.padEnd(20)} ${s.status.padEnd(12)} $${s.total_cost_usd.toFixed(4).padEnd(9)} ${s.started_at}`
        )
      }
    })
)

// --- show ---

const showCommand = Command.make(
  "show",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const s = yield* kernel.get(`/api/sessions/${id}`, SessionDetail)

      yield* Console.log(`Session: ${s.id}`)
      yield* Console.log("-".repeat(50))
      yield* Console.log(`Agent:   ${s.agent_name}`)
      yield* Console.log(`Status:  ${s.status}`)
      yield* Console.log(`Started: ${s.started_at}`)
      yield* Console.log(`Ended:   ${s.ended_at ?? "(active)"}`)
      yield* Console.log(`Cost:    $${s.total_cost_usd.toFixed(4)}`)
      yield* Console.log(`Tokens:  ${s.total_input_tokens} in / ${s.total_output_tokens} out`)
    })
)

// --- spans ---

const spansCommand = Command.make(
  "spans",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const spans = yield* kernel.get(`/api/sessions/${id}/spans`, SpanList)

      if (spans.length === 0) {
        yield* Console.log("No spans found.")
        return
      }

      yield* Console.log(`${"Operation".padEnd(30)} ${"Type".padEnd(10)} ${"Status".padEnd(10)} ${"Duration".padEnd(10)} Cost`)
      yield* Console.log("-".repeat(75))
      for (const sp of spans) {
        const dur = sp.duration_ms != null ? `${sp.duration_ms}ms` : "-"
        yield* Console.log(
          `${sp.operation_name.slice(0, 28).padEnd(30)} ${sp.span_type.padEnd(10)} ${sp.status.padEnd(10)} ${dur.padEnd(10)} $${sp.cost_usd.toFixed(4)}`
        )
      }
    })
)

// --- tree ---

const treeCommand = Command.make(
  "tree",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const tree = yield* kernel.get(`/api/sessions/${id}/tree`, TraceTree)

      yield* Console.log(`Trace Tree for ${tree.session_id} (${tree.span_count} spans)`)
      yield* Console.log("-".repeat(60))
      for (const node of tree.spans) {
        const dur = node.duration_ms != null ? `${node.duration_ms}ms` : "-"
        yield* Console.log(
          `  ${node.operation_name.padEnd(30)} ${node.span_type.padEnd(10)} ${node.status.padEnd(8)} ${dur}`
        )
      }
    })
)

// --- end ---

const endCommand = Command.make(
  "end",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        `/api/sessions/${id}/end`,
        { status: "completed" },
        EndResult
      )
      yield* Console.log(`Session ${result.session_id} ended: ${result.status}`)
      if (result.loops_detected > 0) {
        yield* Console.log(`Warning: ${result.loops_detected} loops detected`)
      }
    })
)

// --- score (auto-score) ---

const autoScoreCommand = Command.make(
  "score",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const scores = yield* kernel.post(
        `/api/sessions/${id}/auto-score`,
        {},
        ScoreList
      )

      if (scores.length === 0) {
        yield* Console.log("No scores generated.")
        return
      }

      yield* Console.log(`Auto-scores for session ${id}:`)
      yield* Console.log(`${"Name".padEnd(25)} ${"Value".padEnd(10)} Source`)
      yield* Console.log("-".repeat(45))
      for (const s of scores) {
        yield* Console.log(`${s.name.padEnd(25)} ${s.value.toFixed(2).padEnd(10)} ${s.source}`)
      }
    })
)

// --- loops ---

const loopsCommand = Command.make(
  "loops",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const info = yield* kernel.get(`/api/sessions/${id}/loops`, LoopInfo)
      yield* Console.log(`Session: ${info.session_id}`)
      yield* Console.log(`Loops detected: ${info.count}`)
    })
)

// --- cost ---

const costCommand = Command.make(
  "cost",
  { id: sessionId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const data = yield* kernel.get(`/api/sessions/${id}/cost-breakdown`, CostBreakdown)

      yield* Console.log(`Cost Breakdown for ${data.session_id}`)
      yield* Console.log(`${"Model".padEnd(30)} ${"Cost".padEnd(12)} ${"In Tokens".padEnd(12)} ${"Out Tokens".padEnd(12)} Spans`)
      yield* Console.log("-".repeat(75))
      for (const b of data.breakdown) {
        yield* Console.log(
          `${b.model.padEnd(30)} $${b.cost_usd.toFixed(4).padEnd(11)} ${String(b.input_tokens).padEnd(12)} ${String(b.output_tokens).padEnd(12)} ${b.span_count}`
        )
      }
    })
)

// --- sessions (parent) ---

export const sessionsCommand = Command.make("sessions").pipe(
  Command.withSubcommands([
    listCommand,
    showCommand,
    spansCommand,
    treeCommand,
    endCommand,
    autoScoreCommand,
    loopsCommand,
    costCommand,
  ])
)
