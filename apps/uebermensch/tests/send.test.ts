import { Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HttpDelivererLive, _internal } from "../src/adapters/HttpDeliverer.js"
import { DelivererService } from "../src/services/DelivererService.js"

const { splitChunks, stripFrontmatter, resolveEnvRef, kernelBase } = _internal

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

  it("resolves env-backed target refs", () => {
    process.env.TEST_CHAT_ID = "42"
    expect(resolveEnvRef("tg:chat:env:TEST_CHAT_ID", "tg:chat:")).toBe("42")
    expect(resolveEnvRef("tg:chat:123", "tg:chat:")).toBe("123")
    expect(resolveEnvRef("dc:webhook:https://x", "tg:chat:")).toBe(null)
    delete process.env.TEST_CHAT_ID
  })

  it("strips trailing slash from GCTRL_KERNEL_URL", () => {
    const prev = process.env.GCTRL_KERNEL_URL
    process.env.GCTRL_KERNEL_URL = "http://kernel.local:4318/"
    expect(kernelBase()).toBe("http://kernel.local:4318")
    process.env.GCTRL_KERNEL_URL = prev
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
      }).pipe(Effect.provide(HttpDelivererLive)),
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
      }).pipe(Effect.provide(HttpDelivererLive)),
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
      }).pipe(Effect.provide(HttpDelivererLive)),
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
      }).pipe(Effect.provide(HttpDelivererLive)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
