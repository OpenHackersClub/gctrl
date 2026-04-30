import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

const mountPersonal = {
  id: "mnt-1",
  name: "personal",
  root_path: "/Users/me/notes",
  kind: "workspace",
  git_url: null,
  app_id: null,
  last_commit_sha: null,
  last_synced_at: null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
}

const mountKb = {
  ...mountPersonal,
  id: "mnt-2",
  name: "kb",
  root_path: "/Users/me/kb",
}

const VaultMount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root_path: Schema.String,
  kind: Schema.String,
})
const VaultMountList = Schema.Array(VaultMount)

const VaultPagePut = Schema.Struct({
  mount: Schema.String,
  path: Schema.String,
  abs_path: Schema.String,
  content_hash: Schema.String,
})

const VaultPageGet = Schema.Struct({
  mount: Schema.String,
  path: Schema.String,
  content: Schema.String,
  content_hash: Schema.String,
})

const MockLayer = createMockKernelClient(
  {
    "/api/vault/mounts": [mountPersonal, mountKb],
    "/api/vault/page": {
      mount: "kb",
      path: "notes/hello.md",
      abs_path: "/Users/me/kb/notes/hello.md",
      content: "# hello\nworld\n",
      content_hash: "0".repeat(64),
    },
  },
  {
    "/api/vault/mounts": {
      ...mountPersonal,
      name: "newmount",
      root_path: "/tmp/new",
    },
    "/api/vault/page": {
      mount: "kb",
      path: "notes/hello.md",
      abs_path: "/Users/me/kb/notes/hello.md",
      content_hash: "abcd".repeat(16),
    },
  },
)

describe("Vault commands (via KernelClient)", () => {
  it("list mounts decodes and returns all", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/vault/mounts", VaultMountList)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("personal")
    expect(result[1].name).toBe("kb")
  })

  it("create mount returns the created record", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/vault/mounts",
        { name: "newmount", root_path: "/tmp/new", kind: "workspace" },
        VaultMount,
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.name).toBe("newmount")
    expect(result.root_path).toBe("/tmp/new")
  })

  it("delete mount calls the delete route", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.delete("/api/vault/mounts/personal")
    })
    await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
  })

  it("get page returns content + hash", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/vault/page?mount=kb&path=notes/hello.md",
        VaultPageGet,
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.content).toBe("# hello\nworld\n")
    expect(result.content_hash.length).toBe(64)
  })

  it("put page returns the new content_hash", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/vault/page",
        { mount: "kb", path: "notes/hello.md", content: "x" },
        VaultPagePut,
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.path).toBe("notes/hello.md")
    expect(result.content_hash).toMatch(/^abcd/)
  })
})
