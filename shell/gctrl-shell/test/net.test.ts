import { describe, it, expect, vi } from "vitest"
import { Effect } from "effect"
import { execPromise } from "../src/lib/exec"

/**
 * Net commands delegate to the gctrl Rust binary.
 * These tests verify the exec helper behavior with mocked subprocess calls.
 */

describe("Net commands (exec helper)", () => {
  it("execPromise returns ok=true for successful command", async () => {
    const result = await Effect.runPromise(
      execPromise("echo hello", process.cwd())
    )

    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello")
  })

  it("execPromise returns ok=false for failed command", async () => {
    const result = await Effect.runPromise(
      execPromise("false", process.cwd())
    )

    expect(result.ok).toBe(false)
  })

  it("execPromise captures stderr in output", async () => {
    const result = await Effect.runPromise(
      execPromise("echo error >&2", process.cwd())
    )

    expect(result.output).toContain("error")
  })

  it("execPromise handles missing command gracefully", async () => {
    const result = await Effect.runPromise(
      execPromise("nonexistent_command_12345", process.cwd())
    )

    expect(result.ok).toBe(false)
  })
})
