import { Effect, Exit, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EnvSecretsLive } from "../src/adapters/EnvSecrets.js"
import { HttpDelivererLive, _internal } from "../src/adapters/HttpDeliverer.js"
import { DelivererService } from "../src/services/DelivererService.js"

const { splitChunks, splitBrief, stripFrontmatter, resolveEnvRef, kernelBase } = _internal

const HttpDelivererWithEnv = HttpDelivererLive.pipe(Layer.provide(EnvSecretsLive))

describe("HttpDeliverer pure helpers", () => {
  it("splits long content on line boundaries", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const chunks = splitChunks(lines, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    expect(chunks.join("\n")).toBe(lines)
  })

  it("returns one chunk when content fits", () => {
    expect(splitChunks("short", 100)).toEqual(["short"])
  })

  it("strips YAML frontmatter", () => {
    const md = "---\nfoo: bar\n---\n\n# Title\n\nBody"
    expect(stripFrontmatter(md)).toBe("# Title\n\nBody")
  })

  it("leaves body-only markdown unchanged", () => {
    expect(stripFrontmatter("# Title\n\nBody")).toBe("# Title\n\nBody")
  })

  it("parses env-backed target ref into { kind: 'env', key }", () => {
    expect(resolveEnvRef("tg:chat:env:TEST_CHAT_ID", "tg:chat:")).toEqual({
      kind: "env",
      key: "TEST_CHAT_ID",
    })
  })

  it("parses literal target ref into { kind: 'literal', value }", () => {
    expect(resolveEnvRef("tg:chat:123", "tg:chat:")).toEqual({ kind: "literal", value: "123" })
  })

  it("returns null when prefix does not match", () => {
    expect(resolveEnvRef("dc:webhook:https://x", "tg:chat:")).toBeNull()
  })

  it("strips trailing slash from GCTRL_KERNEL_URL", () => {
    const prev = process.env.GCTRL_KERNEL_URL
    process.env.GCTRL_KERNEL_URL = "http://kernel.local:4318/"
    expect(kernelBase()).toBe("http://kernel.local:4318")
    process.env.GCTRL_KERNEL_URL = prev
  })
})

describe("splitBrief (item-boundary chunking)", () => {
  const sampleBrief = [
    "---",
    "page_type: brief",
    "slug: brief-2026-04-22",
    "---",
    "",
    "# Daily brief — 2026-04-22",
    "",
    "## 1. First item",
    "",
    "Summary of first item with [[some-page]].",
    "",
    "## 2. Second item",
    "",
    "Summary of second item.",
    "",
    "## 3. Third item",
    "",
    "Summary of third item.",
  ].join("\n")

  it("splits a brief into one chunk per numbered item", () => {
    const chunks = splitBrief(sampleBrief, 3800)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatch(/^## 1\. First item/)
    expect(chunks[1]).toMatch(/^## 2\. Second item/)
    expect(chunks[2]).toMatch(/^## 3\. Third item/)
  })

  it("drops frontmatter and the top-level H1", () => {
    const chunks = splitBrief(sampleBrief, 3800)
    for (const c of chunks) {
      expect(c).not.toContain("page_type: brief")
      expect(c).not.toContain("# Daily brief")
    }
  })

  it("falls back to byte-chunking when no item headings are present", () => {
    const raw = "plain markdown with no item headings at all, just prose"
    expect(splitBrief(raw, 3800)).toEqual([raw])
  })

  it("sub-chunks an overlong item on line boundaries", () => {
    const bigLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const md = `## 1. Big item\n\n${bigLines}\n\n## 2. Small item\n\nhi`
    const chunks = splitBrief(md, 200)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
    expect(chunks[chunks.length - 1]).toMatch(/^## 2\. Small item/)
  })
})

describe("HttpDeliverer send (kernel-routed)", () => {
  const originalFetch = globalThis.fetch
  const prevKernel = process.env.GCTRL_KERNEL_URL

  beforeEach(() => {
    process.env.GCTRL_KERNEL_URL = "http://kernel.test"
    process.env.TEST_CHAT_ID = "99"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.GCTRL_KERNEL_URL = prevKernel
    delete process.env.TEST_CHAT_ID
  })

  it("POSTs telegram to kernel driver and returns external id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message_id: 777 }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "telegram_primary",
          driver: "telegram",
          targetRef: "tg:chat:env:TEST_CHAT_ID",
          silent: false,
          content: "---\nx: 1\n---\n\n# Brief\n\nhi",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(HttpDelivererWithEnv)),
    )

    expect(result.externalIds).toEqual(["777"])
    expect(result.parts).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("http://kernel.test/api/telegram/send")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.chat_id).toBe("99")
    expect(body.text).toBe("# Brief\n\nhi")
    expect(body.disable_notification).toBe(false)
  })

  it("POSTs discord to kernel driver with webhook url in body", async () => {
    process.env.TEST_WEBHOOK = "https://discord.com/api/webhooks/1/abc"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "discord_feed",
          driver: "discord",
          targetRef: "dc:webhook:env:TEST_WEBHOOK",
          silent: false,
          content: "hello",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(HttpDelivererWithEnv)),
    )

    expect(result.parts).toBe(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("http://kernel.test/api/discord/send")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.webhook_url).toBe("https://discord.com/api/webhooks/1/abc")
    expect(body.content).toBe("hello")
    delete process.env.TEST_WEBHOOK
  })

  it("surfaces kernel 503 as config error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "TELEGRAM_BOT_TOKEN not configured",
    }) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "telegram_primary",
          driver: "telegram",
          targetRef: "tg:chat:env:TEST_CHAT_ID",
          silent: false,
          content: "hi",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(HttpDelivererWithEnv)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails with config error when telegram target_ref env var is empty", async () => {
    delete process.env.TEST_CHAT_ID
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "telegram_primary",
          driver: "telegram",
          targetRef: "tg:chat:env:TEST_CHAT_ID",
          silent: false,
          content: "hi",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(HttpDelivererWithEnv)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
