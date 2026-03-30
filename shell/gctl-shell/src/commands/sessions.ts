import { Command, Options } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient.js"

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

const agent = Options.text("agent").pipe(Options.optional)
const status = Options.text("status").pipe(Options.optional)
const limit = Options.integer("limit").pipe(Options.withDefault(20))

export const sessionsCommand = Command.make(
  "sessions",
  { agent, status, limit },
  ({ agent, status, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (agent._tag === "Some") params.set("agent", agent.value)
      if (status._tag === "Some") params.set("status", status.value)

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
