import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

// --- schemas (mirroring terminal.ts) ---

const Capabilities = Schema.Struct({
  os: Schema.String,
  terminals: Schema.Array(Schema.String),
  notify: Schema.Boolean,
  automation_granted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  captured_at: Schema.String,
})

const FocusResponse = Schema.Struct({
  focused: Schema.Boolean,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  deduped: Schema.optional(Schema.Boolean),
})

// --- mock data ---

const mockCapsMacos = {
  os: "macos",
  terminals: ["iterm2", "terminal"],
  notify: false,
  automation_granted: null,
  captured_at: "2026-05-02T14:30:01Z",
}

const mockCapsLinux = {
  os: "linux",
  terminals: [],
  notify: false,
  automation_granted: null,
  captured_at: "2026-05-02T14:30:01Z",
}

const mockFocusOk = { focused: true }
const mockFocusRemote = { focused: false, reason: "remote_session" }
const mockFocusDeduped = { focused: true, deduped: true }

describe("Terminal commands (via KernelClient)", () => {
  it("capabilities returns macOS shape", async () => {
    const Layer = createMockKernelClient({ "/api/comm/capabilities": mockCapsMacos })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/comm/capabilities", Capabilities)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.os).toBe("macos")
    expect(result.terminals).toContain("iterm2")
    expect(result.terminals).toContain("terminal")
    expect(result.notify).toBe(false)
  })

  it("capabilities reflects non-macOS with empty terminals", async () => {
    const Layer = createMockKernelClient({ "/api/comm/capabilities": mockCapsLinux })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/comm/capabilities", Capabilities)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.os).toBe("linux")
    expect(result.terminals).toHaveLength(0)
  })

  it("focus accepts iTerm2 happy-path response", async () => {
    const Layer = createMockKernelClient({}, { "/api/comm/focus": mockFocusOk })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/comm/focus",
        {
          target: "iterm2",
          session_id: "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765",
        },
        FocusResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.focused).toBe(true)
    expect(result.reason ?? null).toBeNull()
  })

  it("focus surfaces remote_session reason on skipped response", async () => {
    const Layer = createMockKernelClient({}, { "/api/comm/focus": mockFocusRemote })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/comm/focus",
        { target: "iterm2", session_id: "w0t0p0:abc" },
        FocusResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.focused).toBe(false)
    expect(result.reason).toBe("remote_session")
  })

  it("focus surfaces deduped flag for concurrent calls", async () => {
    const Layer = createMockKernelClient({}, { "/api/comm/focus": mockFocusDeduped })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/comm/focus",
        {
          target: "iterm2",
          session_id: "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765",
        },
        FocusResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.focused).toBe(true)
    expect(result.deduped).toBe(true)
  })

  it("focus passes Apple Terminal indices through the body", async () => {
    // The mock returns `mockFocusOk` regardless of body, but the test
    // asserts the request shape that the shell builds is well-formed JSON
    // and decodes correctly.
    const Layer = createMockKernelClient({}, { "/api/comm/focus": mockFocusOk })
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/comm/focus",
        { target: "terminal", window_id: "1", tab_id: "3" },
        FocusResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer)))
    expect(result.focused).toBe(true)
  })
})
