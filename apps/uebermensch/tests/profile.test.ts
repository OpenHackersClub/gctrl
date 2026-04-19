import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { FileSystemProfileLive } from "../src/adapters/FileSystemProfile.js"
import { ProfileService } from "../src/services/ProfileService.js"

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, "./fixtures/vault")

describe("FileSystemProfileLive (md+frontmatter)", () => {
  it("loads profile, topics, sources from the fixture vault", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* ProfileService
      return yield* svc.load()
    }).pipe(Effect.provide(FileSystemProfileLive(FIXTURE)))

    const loaded = await Effect.runPromise(program)
    expect(loaded.profile.identity.slug).toBe("new-user")
    expect(loaded.topics.topics[0]?.slug).toBe("example-topic")
    expect(loaded.sources.sources[0]?.driver).toBe("manual")
  })

  it("validate returns no issues for the fixture vault", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* ProfileService
      return yield* svc.validate()
    }).pipe(Effect.provide(FileSystemProfileLive(FIXTURE)))

    const issues = await Effect.runPromise(program)
    expect(issues).toEqual([])
  })
})
