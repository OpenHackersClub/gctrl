import { Effect, Exit, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnthropicLlmLive } from "../src/adapters/AnthropicLlm.js"
import { EnvSecretsLive } from "../src/adapters/EnvSecrets.js"
import { LlmService } from "../src/services/LlmService.js"
import { SecretsService } from "../src/services/SecretsService.js"

const TEST_BASE = "https://anthropic.test"
const TEST_MODEL = "claude-opus-4-7"

const anthropicJson = (jsonBlock: unknown, usage = { input_tokens: 100, output_tokens: 200 }) => ({
  model: TEST_MODEL,
  usage,
  content: [
    {
      type: "text",
      text: `\`\`\`json\n${JSON.stringify(jsonBlock)}\n\`\`\``,
    },
  ],
})

describe("AnthropicLlm direct adapter", () => {
  const originalFetch = globalThis.fetch
  const prevBase = process.env.UBER_ANTHROPIC_BASE_URL
  const prevModel = process.env.UBER_LLM_MODEL
  const prevSummaryModel = process.env.UBER_LLM_SUMMARY_MODEL
  const prevApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    process.env.UBER_ANTHROPIC_BASE_URL = TEST_BASE
    process.env.UBER_LLM_MODEL = TEST_MODEL
    process.env.UBER_LLM_SUMMARY_MODEL = TEST_MODEL
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fixture"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.UBER_ANTHROPIC_BASE_URL = prevBase
    if (prevModel === undefined) delete process.env.UBER_LLM_MODEL
    else process.env.UBER_LLM_MODEL = prevModel
    if (prevSummaryModel === undefined) delete process.env.UBER_LLM_SUMMARY_MODEL
    else process.env.UBER_LLM_SUMMARY_MODEL = prevSummaryModel
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
  })

  it("POSTs directly to api.anthropic.com/v1/messages with x-api-key", async () => {
    const payload = anthropicJson({
      items: [
        {
          kind: "news",
          title: "Direct anthropic call",
          summary_md: "Body referencing [[2026-04-18--foo]].",
          topic: "alpha",
          thesis: null,
          source_candidate_ids: ["cand-0000"],
          suggested_action: null,
        },
      ],
      topicsCovered: ["alpha"],
      thesesCovered: [],
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const program = Effect.gen(function* () {
      const llm = yield* LlmService
      return yield* llm.generateBrief({
        date: "2026-04-22",
        profileName: "Test",
        topics: ["alpha"],
        thesesSlugs: [],
        candidates: [
          {
            id: "cand-0000",
            page: {
              relPath: "input/raw/2026-04-18--foo.md",
              stem: "2026-04-18--foo",
              frontmatter: { page_type: "source", slug: "2026-04-18--foo", topics: ["alpha"] },
              body: "Foo body.",
              mtime: new Date("2026-04-20T12:00:00Z"),
            },
            score: 0.9,
          },
        ],
        maxItems: 5,
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(AnthropicLlmLive.pipe(Layer.provide(EnvSecretsLive)))),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${TEST_BASE}/v1/messages`)
    expect(init.method).toBe("POST")
    expect(init.headers["x-api-key"]).toBe("sk-ant-test-fixture")
    expect(init.headers["anthropic-version"]).toBe("2023-06-01")
    expect(init.headers["x-service-name"]).toBe("uebermensch")
    const body = JSON.parse(init.body)
    expect(body.model).toBe(TEST_MODEL)
    expect(body.system).toContain("brief")
    expect(body.messages).toEqual([{ role: "user", content: expect.any(String) }])

    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe("Direct anthropic call")
    expect(result.model).toBe(TEST_MODEL)
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it("fails with a typed LlmError when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const program = Effect.gen(function* () {
      const llm = yield* LlmService
      return yield* llm.generateBrief({
        date: "2026-04-22",
        profileName: "Test",
        topics: ["alpha"],
        thesesSlugs: [],
        candidates: [],
        maxItems: 5,
      })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(AnthropicLlmLive.pipe(Layer.provide(EnvSecretsLive)))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    if (Exit.isFailure(exit)) {
      const failure = JSON.stringify(exit.cause)
      expect(failure).toMatch(/ANTHROPIC_API_KEY/)
    }
  })

  it("uses an injected SecretsService over process.env", async () => {
    delete process.env.ANTHROPIC_API_KEY
    const payload = anthropicJson({
      items: [],
      topicsCovered: [],
      thesesCovered: [],
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const InMemorySecrets = Layer.succeed(SecretsService, {
      get: (key) =>
        Effect.succeed(
          key === "ANTHROPIC_API_KEY"
            ? Option.some("sk-ant-from-keychain")
            : Option.none(),
        ),
      has: (key) => Effect.succeed(key === "ANTHROPIC_API_KEY"),
    })

    const program = Effect.gen(function* () {
      const llm = yield* LlmService
      return yield* llm.generateBrief({
        date: "2026-04-22",
        profileName: "Test",
        topics: ["alpha"],
        thesesSlugs: [],
        candidates: [],
        maxItems: 5,
      })
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(AnthropicLlmLive.pipe(Layer.provide(InMemorySecrets)))),
    )
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers["x-api-key"]).toBe("sk-ant-from-keychain")
  })

  it("classifies HTTP 429 as rate_limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":"rate_limited"}',
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const program = Effect.gen(function* () {
      const llm = yield* LlmService
      return yield* llm.generateBrief({
        date: "2026-04-22",
        profileName: "Test",
        topics: [],
        thesesSlugs: [],
        candidates: [],
        maxItems: 5,
      })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(AnthropicLlmLive.pipe(Layer.provide(EnvSecretsLive)))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = JSON.stringify(exit.cause)
      expect(failure).toMatch(/rate_limited|429/)
    }
  })
})
