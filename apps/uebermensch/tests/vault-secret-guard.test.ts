import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { vaultSecretGuard } from "../src/adapters/VaultSecretGuard.js"
import { VaultSecretLeakError } from "../src/errors.js"
import { VaultWriterPort, type VaultEntry, type WrittenEntry } from "../src/services/VaultWriterPort.js"

// ---------------------------------------------------------------------------
// Fake in-memory VaultWriterPort for testing
// ---------------------------------------------------------------------------

const makeInMemoryVaultWriter = () => {
  const store = new Map<string, string>()

  const impl: import("../src/services/VaultWriterPort.js").VaultWriterPortShape = {
    write: (path, content) =>
      Effect.sync(() => {
        store.set(path, content)
        const hash = `sha256:${Buffer.from(content).toString("hex").slice(0, 16)}`
        return { contentHash: hash } satisfies WrittenEntry
      }),
    read: (path) =>
      Effect.sync(() => {
        const v = store.get(path)
        return v !== undefined ? Option.some(v) : Option.none()
      }),
    list: (prefix) =>
      Effect.sync(() => {
        const entries: Array<VaultEntry> = []
        for (const p of store.keys()) {
          if (p.startsWith(prefix)) {
            entries.push({ path: p, mtime: new Date(0) })
          }
        }
        return entries
      }),
    delete: (path) =>
      Effect.sync(() => {
        store.delete(path)
      }),
  }

  return { store, impl }
}

// Layer factory — creates a fresh store per test
const makeFakeLayer = () => {
  const { store, impl } = makeInMemoryVaultWriter()
  const layer = Layer.succeed(VaultWriterPort, impl)
  return { store, layer }
}

// Run an Effect under the guarded layer and return the Exit
const runGuarded = <A, E>(
  effect: Effect.Effect<A, E, VaultWriterPort>,
  innerLayer: Layer.Layer<VaultWriterPort>,
) => Effect.runPromise(Effect.exit(Effect.provide(effect, vaultSecretGuard(innerLayer))))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vaultSecretGuard — write passthrough", () => {
  it("allows clean content and delegates to the inner adapter", async () => {
    const { store, layer } = makeFakeLayer()
    const path = "input/briefs/2026-05-02.md"
    const content = "# Brief\n\nSome safe content here."

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.write(path, content)
      }),
      layer,
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(store.get(path)).toBe(content)
  })

  it("returns a content hash on successful write", async () => {
    const { layer } = makeFakeLayer()
    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.write("notes/foo.md", "clean note")
      }),
      layer,
    )
    if (Exit.isSuccess(exit)) {
      expect(exit.value.contentHash).toMatch(/^sha256:/)
    } else {
      expect.fail("expected success")
    }
  })
})

describe("vaultSecretGuard — write blocking", () => {
  it("blocks write containing an Anthropic API key", async () => {
    const { store, layer } = makeFakeLayer()
    const path = "input/raw/bad.md"
    // Split-prefix fixture so GitHub's push-time secret scanner doesn't reject the file.
    const content = `My token: ${"sk-ant" + "-api03-DeadBeefDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef"}`

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.write(path, content)
      }),
      layer,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = exit.cause
      // Unwrap the Fail cause to get at the error value
      const err = (cause as unknown as { error: unknown }).error
      expect(err).toBeInstanceOf(VaultSecretLeakError)
      const leak = err as VaultSecretLeakError
      expect(leak.path).toBe(path)
      expect(leak.leaks.length).toBeGreaterThan(0)
      expect(leak.leaks[0]!.name).toBe("anthropic_api_key")
    }
    // Inner adapter must NOT have been called
    expect(store.has(path)).toBe(false)
  })

  it("blocks write containing a GitHub PAT", async () => {
    const { store, layer } = makeFakeLayer()
    const path = "input/raw/creds.md"
    const content = `token: ${"ghp" + "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm"}`

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.write(path, content)
      }),
      layer,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(store.has(path)).toBe(false)
  })
})

describe("vaultSecretGuard — passthrough methods", () => {
  it("delegates read to the inner adapter", async () => {
    const { store, layer } = makeFakeLayer()
    store.set("notes/x.md", "hello")

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.read("notes/x.md")
      }),
      layer,
    )

    if (Exit.isSuccess(exit)) {
      expect(Option.isSome(exit.value)).toBe(true)
      expect(Option.getOrNull(exit.value)).toBe("hello")
    } else {
      expect.fail("expected success")
    }
  })

  it("delegates list to the inner adapter", async () => {
    const { store, layer } = makeFakeLayer()
    store.set("input/raw/a.md", "a")
    store.set("input/raw/b.md", "b")
    store.set("input/reports/c.md", "c")

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.list("input/raw/")
      }),
      layer,
    )

    if (Exit.isSuccess(exit)) {
      const paths = exit.value.map((e) => e.path).sort()
      expect(paths).toEqual(["input/raw/a.md", "input/raw/b.md"])
    } else {
      expect.fail("expected success")
    }
  })

  it("delegates delete to the inner adapter", async () => {
    const { store, layer } = makeFakeLayer()
    store.set("notes/del.md", "to delete")

    const exit = await runGuarded(
      Effect.gen(function* () {
        const port = yield* VaultWriterPort
        return yield* port.delete("notes/del.md")
      }),
      layer,
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(store.has("notes/del.md")).toBe(false)
  })
})
