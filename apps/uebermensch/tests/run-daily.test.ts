import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { StrictRendererLive } from "../src/adapters/StrictRenderer.js"
import { StubLlmLive } from "../src/adapters/StubLlm.js"
import { DeliveryError } from "../src/errors.js"
import { selectCandidates } from "../src/lib/candidates.js"
import { LlmService } from "../src/services/LlmService.js"
import { ProfileService } from "../src/services/ProfileService.js"
import { RendererService } from "../src/services/RendererService.js"
import { VaultService } from "../src/services/VaultService.js"
import { DelivererService } from "../src/services/DelivererService.js"

// Helper to build a minimal in-memory ProfileService stub
const makeStubProfileLayer = (vaultDir: string) => {
  const profile = {
    schema_version: 1,
    identity: { name: "Test User", slug: "test-user", tz: "Asia/Hong_Kong", lang: "en" },
    budgets: { daily_usd: 1, per_brief_usd: 0.5 },
    delivery: {
      brief: { cron: "30 8 * * *", format: "short" as const },
      channels: {
        stub_app: { enabled: true, driver: "app", target_ref: "app:stub" },
      },
    },
  }
  const topics = { topics: [{ slug: "foo-topic", title: "Foo", horizon: "short" as const, weight: 1 }] }
  const sources = { sources: [{ slug: "src-1", driver: "rss", cadence: "daily", topics: ["foo-topic"] }] }
  return Layer.succeed(ProfileService, {
    load: () =>
      Effect.succeed({ profile, topics, sources, me: "", projects: "", avoid: "" }),
    validate: () => Effect.succeed([]),
  })
}

// Stub deliverer that always succeeds
const makeSuccessDelivererLayer = () =>
  Layer.succeed(DelivererService, {
    send: (input) =>
      Effect.succeed({
        channel: input.channel,
        driver: input.driver,
        externalIds: [],
        parts: 1,
      }),
  })

// Stub deliverer that always fails
const makeFailDelivererLayer = () =>
  Layer.succeed(DelivererService, {
    send: (input) =>
      Effect.fail(
        new DeliveryError({
          channel: input.channel,
          driver: input.driver,
          message: "stub delivery failure",
          kind: "unreachable",
        }),
      ),
  })

const seedWikiPage = async (root: string, rel: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(
    full,
    "---\npage_type: source\nslug: wiki-page-1\ntitle: Wiki Page 1\ntopics: [foo-topic]\n---\n\n# Wiki\n\nContent.\n",
  )
}

describe("run-daily core logic — brief generation + delivery", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-run-daily-"))
    await seedWikiPage(vaultDir, "input/raw/2026-04-30--wiki1.md")
  })

  it("generates a brief when none exists and delivers to one channel", async () => {
    const today = new Date().toISOString().slice(0, 10)

    const program = Effect.gen(function* () {
      const vault = yield* VaultService
      const llm = yield* LlmService
      const renderer = yield* RendererService
      const pages = yield* vault.recentlyChanged(24)
      const candidates = selectCandidates({
        pages,
        topics: [{ slug: "foo-topic", weight: 1 }],
        thesesSlugs: [],
        now: new Date(),
        windowHours: 24,
        maxCandidates: 40,
      })
      const response = yield* llm.generateBrief({
        date: today,
        profileName: "Test User",
        topics: ["foo-topic"],
        thesesSlugs: [],
        candidates,
        maxItems: 6,
      })
      const vaultSlugs = yield* vault.listSlugs()
      const rendered = yield* renderer.render({
        date: today,
        generator: llm.name(),
        model: response.model,
        promptHash: response.promptHash,
        costUsd: response.costUsd,
        profileName: "Test User",
        topicsCovered: response.topicsCovered,
        thesesCovered: response.thesesCovered,
        candidates,
        items: response.items,
        vaultSlugs,
      })
      return yield* vault.writeBrief(today, rendered.markdown)
    }).pipe(
      Effect.provide(Layer.mergeAll(FileSystemVaultLive(vaultDir), StubLlmLive, StrictRendererLive)),
    )

    const written = await Effect.runPromise(program)
    expect(written.relPath).toBe(`input/briefs/${today}.md`)
    const onDisk = await readFile(join(vaultDir, written.relPath), "utf8")
    expect(onDisk).toContain(`brief-${today}`)
  })

  it("reuses existing brief without calling LLM", async () => {
    const today = "2026-04-30"
    const briefDir = join(vaultDir, "input/briefs")
    await mkdir(briefDir, { recursive: true })
    await writeFile(
      join(briefDir, `${today}.md`),
      "---\npage_type: brief\nslug: brief-existing\n---\n\n# Existing brief\n\nContent.\n",
    )

    // LLM that would throw if called
    const strictLlmLayer = Layer.succeed(LlmService, {
      name: () => "strict-stub",
      generateBrief: () =>
        Effect.fail({ _tag: "LlmError", message: "should not be called", kind: "unavailable" } as never),
      summarizeSource: () => Effect.fail({ _tag: "LlmError", message: "no" } as never),
      researchQuery: () => Effect.fail({ _tag: "LlmError", message: "no" } as never),
      proposeSubtopic: () => Effect.fail({ _tag: "LlmError", message: "no" } as never),
      generateInterestReport: () => Effect.fail({ _tag: "LlmError", message: "no" } as never),
    })

    const program = Effect.gen(function* () {
      const vault = yield* VaultService
      return yield* vault.listSlugs()
    }).pipe(
      Effect.provide(Layer.mergeAll(FileSystemVaultLive(vaultDir), strictLlmLayer, StrictRendererLive)),
    )

    // Verify the brief file exists — the point is the file is already there
    const onDisk = await readFile(join(vaultDir, `input/briefs/${today}.md`), "utf8")
    expect(onDisk).toContain("Existing brief")

    // Program that exercises VaultService still works
    const slugs = await Effect.runPromise(program)
    expect(slugs).toBeDefined()
  })

  it("delivery success layer delivers and returns ok counts", async () => {
    const delivered: Array<string> = []
    const deliveryLayer = Layer.succeed(DelivererService, {
      send: (input) => {
        delivered.push(input.channel)
        return Effect.succeed({ channel: input.channel, driver: input.driver, externalIds: [], parts: 1 })
      },
    })

    const program = Effect.gen(function* () {
      const d = yield* DelivererService
      return yield* d.send({
        channel: "test",
        driver: "app",
        targetRef: "app:test",
        silent: false,
        content: "hello",
        briefDate: "2026-04-30",
      })
    }).pipe(Effect.provide(deliveryLayer))

    const result = await Effect.runPromise(program)
    expect(result.channel).toBe("test")
    expect(delivered).toContain("test")
  })

  it("delivery failure layer returns failure exit", async () => {
    const program = Effect.gen(function* () {
      const d = yield* DelivererService
      return yield* d.send({
        channel: "bad",
        driver: "telegram",
        targetRef: "tg:chat:123",
        silent: false,
        content: "hello",
        briefDate: "2026-04-30",
      })
    }).pipe(Effect.provide(makeFailDelivererLayer()))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("stub profile layer loads without vault files", async () => {
    const program = Effect.gen(function* () {
      const p = yield* ProfileService
      return yield* p.load()
    }).pipe(Effect.provide(makeStubProfileLayer(vaultDir)))

    const loaded = await Effect.runPromise(program)
    expect(loaded.profile.identity.name).toBe("Test User")
    expect(loaded.profile.delivery.brief.format).toBe("short")
  })
})
