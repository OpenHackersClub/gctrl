import { Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LMStudioLlmLive } from "../src/adapters/LMStudioLlm.js"
import { LlmService } from "../src/services/LlmService.js"

const TEST_BASE = "http://lmstudio.test:9999"
const TEST_MODEL = "google/gemma-4-31b"

const openAiCompatJson = (
  jsonBlock: unknown,
  usage = { prompt_tokens: 100, completion_tokens: 200 },
) => ({
  model: TEST_MODEL,
  usage,
  choices: [
    {
      message: {
        role: "assistant",
        content: JSON.stringify(jsonBlock),
      },
    },
  ],
})

describe("LMStudioLlm direct adapter", () => {
  const originalFetch = globalThis.fetch
  const prevBase = process.env.UBER_LMSTUDIO_BASE_URL
  const prevModel = process.env.UBER_LLM_MODEL
  const prevSummaryModel = process.env.UBER_LLM_SUMMARY_MODEL

  beforeEach(() => {
    process.env.UBER_LMSTUDIO_BASE_URL = TEST_BASE
    process.env.UBER_LLM_MODEL = TEST_MODEL
    process.env.UBER_LLM_SUMMARY_MODEL = TEST_MODEL
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.UBER_LMSTUDIO_BASE_URL = prevBase
    if (prevModel === undefined) delete process.env.UBER_LLM_MODEL
    else process.env.UBER_LLM_MODEL = prevModel
    if (prevSummaryModel === undefined) delete process.env.UBER_LLM_SUMMARY_MODEL
    else process.env.UBER_LLM_SUMMARY_MODEL = prevSummaryModel
  })

  it("POSTs directly to OpenAI-compat /v1/chat/completions, no auth header", async () => {
    const payload = openAiCompatJson({
      items: [
        {
          kind: "news",
          title: "Local LMStudio call",
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

    const result = await Effect.runPromise(program.pipe(Effect.provide(LMStudioLlmLive)))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${TEST_BASE}/v1/chat/completions`)
    expect(init.method).toBe("POST")
    expect(init.headers["x-api-key"]).toBeUndefined()
    expect(init.headers["authorization"]).toBeUndefined()
    expect(init.headers["x-service-name"]).toBe("uebermensch")

    const body = JSON.parse(init.body)
    expect(body.model).toBe(TEST_MODEL)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe("system")
    expect(body.messages[1].role).toBe("user")
    // brief lane sets a json_schema response_format
    expect(body.response_format?.type).toBe("json_schema")

    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe("Local LMStudio call")
    // Local backend → 0 cost
    expect(result.costUsd).toBe(0)
  })

  it("classifies HTTP 503 as unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "model not loaded",
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

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(LMStudioLlmLive)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = JSON.stringify(exit.cause)
      expect(failure).toMatch(/unavailable|503/)
    }
  })

  it("name() echoes the configured model", async () => {
    const program = Effect.gen(function* () {
      const llm = yield* LlmService
      return llm.name()
    })
    const name = await Effect.runPromise(program.pipe(Effect.provide(LMStudioLlmLive)))
    expect(name).toBe(`lmstudio-direct@${TEST_MODEL}`)
  })
})
