import { Command } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient.js"

const Analytics = Schema.Struct({
  total_sessions: Schema.Number,
  active_sessions: Schema.Number,
  total_spans: Schema.Number,
  total_cost_usd: Schema.Number,
})

export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient

    const healthy = yield* kernel.health()
    if (!healthy) {
      yield* Console.log("Kernel: OFFLINE")
      yield* Console.log("Run 'gctl serve' to start the kernel daemon.")
      return
    }

    yield* Console.log("Kernel: ONLINE (localhost:4318)")

    const analytics = yield* kernel.get("/api/analytics", Analytics).pipe(
      Effect.catchTag("KernelError", () => Effect.succeed(null))
    )

    if (analytics) {
      yield* Console.log("")
      yield* Console.log(`Sessions:  ${analytics.total_sessions} total, ${analytics.active_sessions} active`)
      yield* Console.log(`Spans:     ${analytics.total_spans}`)
      yield* Console.log(`Cost:      $${analytics.total_cost_usd.toFixed(4)}`)
    }
  })
)
