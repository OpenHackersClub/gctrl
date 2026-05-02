import { Effect, Exit, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DirectDelivererLive } from "../src/adapters/DirectDeliverer.js"
import { EnvSecretsLive } from "../src/adapters/EnvSecrets.js"
import { DelivererService } from "../src/services/DelivererService.js"
import { SecretsService } from "../src/services/SecretsService.js"

const TG_BASE = "https://telegram.test"
const DC_BASE = "https://discord.test"

const DirectWithEnv = DirectDelivererLive.pipe(Layer.provide(EnvSecretsLive))

describe("DirectDeliverer telegram", () => {
  const originalFetch = globalThis.fetch
  const prevTgUrl = process.env.UBER_TELEGRAM_API_URL
  const prevToken = process.env.TELEGRAM_BOT_TOKEN
  const prevChatId = process.env.TEST_CHAT_ID

  beforeEach(() => {
    process.env.UBER_TELEGRAM_API_URL = TG_BASE
    process.env.TELEGRAM_BOT_TOKEN = "9876:test-bot-token"
    process.env.TEST_CHAT_ID = "42"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (prevTgUrl === undefined) delete process.env.UBER_TELEGRAM_API_URL
    else process.env.UBER_TELEGRAM_API_URL = prevTgUrl
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = prevToken
    if (prevChatId === undefined) delete process.env.TEST_CHAT_ID
    else process.env.TEST_CHAT_ID = prevChatId
  })

  it("POSTs directly to api.telegram.org/bot<token>/sendMessage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 4242 } }),
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
      }).pipe(Effect.provide(DirectWithEnv)),
    )

    expect(result.externalIds).toEqual(["4242"])
    expect(result.parts).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${TG_BASE}/bot9876:test-bot-token/sendMessage`)
    expect((init as { method: string }).method).toBe("POST")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.chat_id).toBe("42")
    expect(body.text).toBe("# Brief\n\nhi")
    expect(body.disable_notification).toBe(false)
  })

  it("fails with config error when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

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
      }).pipe(Effect.provide(DirectWithEnv)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    if (Exit.isFailure(exit)) {
      const failure = JSON.stringify(exit.cause)
      expect(failure).toMatch(/TELEGRAM_BOT_TOKEN/)
    }
  })

  it("uses an injected SecretsService over process.env", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const InMemorySecrets = Layer.succeed(SecretsService, {
      get: (key) =>
        Effect.succeed(
          key === "TELEGRAM_BOT_TOKEN"
            ? Option.some("1111:keychain-token")
            : key === "TEST_CHAT_ID"
              ? Option.some("99")
              : Option.none(),
        ),
      has: (key) => Effect.succeed(key === "TELEGRAM_BOT_TOKEN" || key === "TEST_CHAT_ID"),
    })

    await Effect.runPromise(
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
      }).pipe(Effect.provide(DirectDelivererLive.pipe(Layer.provide(InMemorySecrets)))),
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${TG_BASE}/bot1111:keychain-token/sendMessage`)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.chat_id).toBe("99")
  })

  it("classifies HTTP 429 as rate_limited", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
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
      }).pipe(Effect.provide(DirectWithEnv)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = JSON.stringify(exit.cause)
      expect(failure).toMatch(/rate_limited/)
    }
  })
})

describe("DirectDeliverer discord", () => {
  const originalFetch = globalThis.fetch
  const prevDcUrl = process.env.UBER_DISCORD_API_URL
  const prevWebhook = process.env.TEST_WEBHOOK

  beforeEach(() => {
    process.env.UBER_DISCORD_API_URL = DC_BASE
    process.env.TEST_WEBHOOK = "https://discord.com/api/webhooks/1/abc"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (prevDcUrl === undefined) delete process.env.UBER_DISCORD_API_URL
    else process.env.UBER_DISCORD_API_URL = prevDcUrl
    if (prevWebhook === undefined) delete process.env.TEST_WEBHOOK
    else process.env.TEST_WEBHOOK = prevWebhook
  })

  it("POSTs directly to the resolved webhook URL (rebased to UBER_DISCORD_API_URL)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "discord_feed",
          driver: "discord",
          targetRef: "dc:webhook:env:TEST_WEBHOOK",
          silent: false,
          content: "hello world",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(DirectWithEnv)),
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    // host rebased onto DC_BASE, path preserved
    expect(url).toBe(`${DC_BASE}/api/webhooks/1/abc`)
    expect((init as { method: string }).method).toBe("POST")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.content).toBe("hello world")
    expect(body.webhook_url).toBeUndefined() // direct mode doesn't pass webhook in body
  })

  it("prefixes silent sends with @silent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "discord_feed",
          driver: "discord",
          targetRef: "dc:webhook:env:TEST_WEBHOOK",
          silent: true,
          content: "hush",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(DirectWithEnv)),
    )

    const [, init] = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } })
      .mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.content).toBe("@silent hush")
  })
})

describe("DirectDeliverer routing", () => {
  it("rejects unknown drivers with a config error", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "x",
          driver: "smoke-signal",
          targetRef: "ss:cloud:big",
          silent: false,
          content: "hi",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(DirectWithEnv)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toMatch(/unknown driver/)
    }
  })

  it("app driver returns success without HTTP", async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* DelivererService
        return yield* d.send({
          channel: "app_inbox",
          driver: "app",
          targetRef: "app:inbox",
          silent: false,
          content: "x",
          briefDate: "2026-04-22",
        })
      }).pipe(Effect.provide(DirectWithEnv)),
    )
    expect(result.parts).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
