/**
 * exec — subprocess helper for shell commands.
 */
import { exec } from "node:child_process"
import { Effect } from "effect"

export interface CheckResult {
  readonly ok: boolean
  readonly output: string
}

export const execPromise = (
  cmd: string,
  cwd: string
): Effect.Effect<CheckResult, never> =>
  Effect.async<CheckResult, never>((resume) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = (stdout ?? "") + (stderr ?? "")
      resume(Effect.succeed({ ok: !error, output }))
    })
  })
