/**
 * Shared passthrough `exec` subcommand builder for CLI drivers.
 *
 * Both `gctrl wrangler` and `gctrl gh` expose an `exec` subcommand that forwards
 * positional args verbatim to the kernel's CLI driver route (which in turn
 * shells out to the native binary). The kernel always returns a structured
 * envelope; this builder writes stdout/stderr to the parent process's streams
 * and propagates the subprocess exit code.
 *
 * Usage:
 *   gctrl wrangler exec -- d1 execute my-db --env preview --remote --command "SELECT 1"
 *   gctrl gh exec -- pr merge 42 --squash --delete-branch
 */
import { Args, Command } from "@effect/cli"
import { Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

export const CliExecResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
})
export type CliExecResult = typeof CliExecResult.Type

const execArgs = Args.text({ name: "args" }).pipe(Args.repeated)

/**
 * Build an `exec` passthrough command that POSTs to the given kernel route.
 * `routePath` is the absolute kernel path (e.g. `/api/wrangler/exec`).
 */
export const makeExecCommand = (routePath: string) =>
  Command.make("exec", { args: execArgs }, ({ args }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        routePath,
        { args: Array.from(args) },
        CliExecResult
      )

      if (result.stdout.length > 0) process.stdout.write(result.stdout)
      if (result.stderr.length > 0) process.stderr.write(result.stderr)
      if (result.exitCode !== 0) process.exit(result.exitCode)
    })
  )
