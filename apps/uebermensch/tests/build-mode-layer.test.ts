import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EnvSecretsLive } from "../src/adapters/EnvSecrets.js"
import { buildDelivererLayer, buildLlmLayer, buildModeLayer } from "../src/lib/build-mode-layer.js"
import { DelivererService } from "../src/services/DelivererService.js"
import { LlmService } from "../src/services/LlmService.js"

// These tests don't actually exercise the full LLM/Deliverer pipeline — they
// verify that buildModeLayer wires the right adapter for each mode by checking
// the URL the resulting Layer fetches, which is the cheapest behavioral
// fingerprint for "is this KernelLlm or AnthropicLlm or LMStudioLlm".

const originalFetch = globalThis.fetch
const ENVS_TO_RESTORE = [
  "GCTRL_KERNEL_URL",
  "UBER_ANTHROPIC_BASE_URL",
  "UBER_LMSTUDIO_BASE_URL",
  "UBER_LLM_MODEL",
  "UBER_LLM_SUMMARY_MODEL",
  "UBER_TELEGRAM_API_URL",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TEST_CHAT_ID",
] as const
const snapshot = Object.fromEntries(ENVS_TO_RESTORE.map((k) => [k, process.env[k]]))

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const k of ENVS_TO_RESTORE) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

const mockFetch = (responseBody: unknown, status = 200) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const callResearchQuery = (layer: Layer.Layer<LlmService>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* LlmService
      return yield* llm.researchQuery({
        slug: "x",
        title: "x",
        topics: [],
        question: "what?",
        profileName: "Test",
        contextPages: [],
      })
    }).pipe(Effect.provide(layer)),
  )

describe("buildLlmLayer", () => {
  it("local-kernel routes through GCTRL_KERNEL_URL", async () => {
    process.env.GCTRL_KERNEL_URL = "http://kernel.fixture"
    process.env.UBER_LLM_MODEL = "claude-opus-4-7"
    const fetchMock = mockFetch({
      content: [{ type: "text", text: "Some answer." }],
      usage: { input_tokens: 10, output_tokens: 20 },
      model: "claude-opus-4-7",
    })
    const layer = buildLlmLayer("local-kernel").pipe(Layer.provide(EnvSecretsLive))
    await callResearchQuery(layer)
    expect(fetchMock.mock.calls[0][0]).toBe("http://kernel.fixture/api/llm/messages")
  })

  it("local-direct + claude-* model routes to AnthropicLlm", async () => {
    process.env.UBER_ANTHROPIC_BASE_URL = "https://anthropic.fixture"
    process.env.UBER_LLM_MODEL = "claude-opus-4-7"
    process.env.ANTHROPIC_API_KEY = "sk-ant-fixture"
    const fetchMock = mockFetch({
      content: [{ type: "text", text: "Direct anthropic answer." }],
      usage: { input_tokens: 5, output_tokens: 10 },
      model: "claude-opus-4-7",
    })
    const layer = buildLlmLayer("local-direct").pipe(Layer.provide(EnvSecretsLive))
    await callResearchQuery(layer)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://anthropic.fixture/v1/messages")
    expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBe(
      "sk-ant-fixture",
    )
  })

  it("local-direct + non-claude model routes to LMStudioLlm", async () => {
    process.env.UBER_LMSTUDIO_BASE_URL = "http://lmstudio.fixture:1234"
    process.env.UBER_LLM_MODEL = "google/gemma-4-31b"
    const fetchMock = mockFetch({
      choices: [{ message: { role: "assistant", content: "Local answer." } }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
      model: "google/gemma-4-31b",
    })
    const layer = buildLlmLayer("local-direct").pipe(Layer.provide(EnvSecretsLive))
    await callResearchQuery(layer)
    expect(fetchMock.mock.calls[0][0]).toBe("http://lmstudio.fixture:1234/v1/chat/completions")
  })

  it("cloud-only routes to AnthropicLlm (operator may rebase via UBER_ANTHROPIC_BASE_URL)", async () => {
    process.env.UBER_ANTHROPIC_BASE_URL =
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic"
    process.env.UBER_LLM_MODEL = "claude-opus-4-7"
    process.env.ANTHROPIC_API_KEY = "sk-ant-cloud"
    const fetchMock = mockFetch({
      content: [{ type: "text", text: "Gateway answer." }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-opus-4-7",
    })
    const layer = buildLlmLayer("cloud-only").pipe(Layer.provide(EnvSecretsLive))
    await callResearchQuery(layer)
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    )
  })

  it("explicit model arg overrides UBER_LLM_MODEL", async () => {
    process.env.UBER_LMSTUDIO_BASE_URL = "http://lmstudio.fixture"
    process.env.UBER_LLM_MODEL = "claude-opus-4-7"
    const fetchMock = mockFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: "google/gemma-4-31b",
    })
    // Override the env hint with an explicit non-claude model arg → LMStudio path
    const layer = buildLlmLayer("local-direct", "google/gemma-4-31b").pipe(
      Layer.provide(EnvSecretsLive),
    )
    await callResearchQuery(layer)
    expect(fetchMock.mock.calls[0][0]).toBe("http://lmstudio.fixture/v1/chat/completions")
  })
})

describe("buildDelivererLayer", () => {
  it("local-kernel routes Telegram through kernel /api/telegram/send", async () => {
    process.env.GCTRL_KERNEL_URL = "http://kernel.fixture"
    process.env.TEST_CHAT_ID = "1"
    const fetchMock = mockFetch({ ok: true, message_id: 1 })
    const layer = buildDelivererLayer("local-kernel").pipe(Layer.provide(EnvSecretsLive))
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
      }).pipe(Effect.provide(layer)),
    )
    expect(fetchMock.mock.calls[0][0]).toBe("http://kernel.fixture/api/telegram/send")
  })

  it("local-direct routes Telegram directly to api.telegram.org", async () => {
    process.env.UBER_TELEGRAM_API_URL = "https://telegram.fixture"
    process.env.TELEGRAM_BOT_TOKEN = "9:tok"
    process.env.TEST_CHAT_ID = "1"
    const fetchMock = mockFetch({ ok: true, result: { message_id: 1 } })
    const layer = buildDelivererLayer("local-direct").pipe(Layer.provide(EnvSecretsLive))
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
      }).pipe(Effect.provide(layer)),
    )
    expect(fetchMock.mock.calls[0][0]).toBe("https://telegram.fixture/bot9:tok/sendMessage")
  })
})

describe("buildModeLayer composition", () => {
  it("composes both LlmService + DelivererService", () => {
    const layer = buildModeLayer("local-direct")
    // Smoke: composing succeeds — type checks already enforce R=SecretsService.
    expect(layer).toBeDefined()
  })
})
