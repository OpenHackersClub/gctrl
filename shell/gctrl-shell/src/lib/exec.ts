/**
 * exec — subprocess helper for shell commands.
 */
import { exec, execFile } from "node:child_process"
import { Effect } from "effect"

export interface CheckResult {
  readonly ok: boolean
  readonly output: string
}

/**
 * Run a shell command string (via /bin/sh). Use only for trusted,
 * internally-constructed commands (e.g. build/lint scripts).
 * NEVER pass user input into cmd — use execFilePromise instead.
 */
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

/**
 * Run a binary with an args array — no shell interpolation.
 * Safe for user-supplied arguments (URLs, file paths, etc.).
 */
export const execFilePromise = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<CheckResult, never> =>
  Effect.async<CheckResult, never>((resume) => {
    execFile(file, [...args], { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = (stdout ?? "") + (stderr ?? "")
      resume(Effect.succeed({ ok: !error, output }))
    })
  })
