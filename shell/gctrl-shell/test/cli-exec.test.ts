import { describe, it, expect } from "vitest"
import { Effect, Either, Layer, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelError, KernelUnavailableError } from "../src/errors"
import { CliExecResult } from "../src/commands/cli-exec"

/**
 * A mock KernelClient that records the last POST body so tests can assert the
 * shell serialized the exec args into { args: string[] }.
 */
type LastCall = { path: string; body: unknown } | null

const recordingMock = (response: unknown) => {
  const last: { value: LastCall } = { value: null }
  const layer = Layer.succeed(KernelClient, {
    get: (_path, _schema) =>
      Effect.fail(new KernelError({ message: "unused", statusCode: 404 })) as never,
    post: (path, body, schema) =>
      Effect.gen(function* () {
        last.value = { path, body }
        return yield* Schema.decodeUnknown(schema)(response)
      }),
    delete: () =>
      Effect.fail(new KernelError({ message: "unused", statusCode: 404 })),
    getText: () =>
      Effect.fail(new KernelError({ message: "unused", statusCode: 404 })),
    health: () => Effect.succeed(true),
  })
  return { layer, last }
}

describe("cli-exec passthrough (shared by wrangler + gh)", () => {
  it("decodes CliExecResult envelope", async () => {
    const { layer } = recordingMock({
      stdout: "👋 You are logged in\n",
      stderr: "",
      exitCode: 0,
      durationMs: 412,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/wrangler/exec",
        { args: ["whoami"] },
        CliExecResult
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("You are logged in")
    expect(result.durationMs).toBe(412)
  })

  it("forwards args array verbatim in POST body (wrangler route)", async () => {
    const { layer, last } = recordingMock({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/wrangler/exec",
        {
          args: ["d1", "execute", "my-db", "--env", "preview", "--remote", "--command", "SELECT 1"],
        },
        CliExecResult
      )
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(last.value?.path).toBe("/api/wrangler/exec")
    const body = last.value?.body as { args: string[] }
    expect(body.args).toEqual([
      "d1",
      "execute",
      "my-db",
      "--env",
      "preview",
      "--remote",
      "--command",
      "SELECT 1",
    ])
  })

  it("forwards to /api/github/exec for gh passthrough", async () => {
    const { layer, last } = recordingMock({
      stdout: "Merged PR #42\n",
      stderr: "",
      exitCode: 0,
      durationMs: 800,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/github/exec",
        { args: ["pr", "merge", "42", "--squash", "--delete-branch"] },
        CliExecResult
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(last.value?.path).toBe("/api/github/exec")
    expect((last.value?.body as { args: string[] }).args).toEqual([
      "pr",
      "merge",
      "42",
      "--squash",
      "--delete-branch",
    ])
    expect(result.stdout).toContain("Merged PR #42")
  })

  it("envelope carries nonzero exit codes for caller to mirror", async () => {
    const { layer } = recordingMock({
      stdout: "",
      stderr: "error: database not found\n",
      exitCode: 1,
      durationMs: 120,
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/wrangler/exec", { args: [] }, CliExecResult)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("database not found")
  })

  it("surfaces KernelUnavailableError when daemon offline", async () => {
    const offline = Layer.succeed(KernelClient, {
      get: () => Effect.fail(new KernelUnavailableError({ message: "offline" })) as never,
      post: () => Effect.fail(new KernelUnavailableError({ message: "offline" })) as never,
      delete: () => Effect.fail(new KernelUnavailableError({ message: "offline" })),
      getText: () => Effect.fail(new KernelUnavailableError({ message: "offline" })),
      health: () => Effect.fail(new KernelUnavailableError({ message: "offline" })),
    })

    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/wrangler/exec", { args: [] }, CliExecResult)
    })

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(offline)))
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelUnavailableError)
    }
  })
})
