import { Command } from "@effect/cli"
import { Effect } from "effect"
import { ScheduleError } from "../errors.js"
import { scheduleSyncProgram } from "./schedule-sync.js"

const sync = Command.make("sync", {}, () =>
  scheduleSyncProgram.pipe(
    Effect.catchTag("ScheduleError", (e) =>
      Effect.gen(function* () {
        yield* Effect.logError(`schedule sync failed: ${e.message}`)
        process.exit(1)
      }),
    ),
  ),
).pipe(Command.withDescription("Reconcile directives/schedules.md to kernel /api/schedules"))

export const schedule = Command.make("schedule").pipe(
  Command.withSubcommands([sync]),
  Command.withDescription("Schedule management commands"),
)

export type { ScheduleError }
