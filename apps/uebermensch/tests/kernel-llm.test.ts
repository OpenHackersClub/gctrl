import { Cause, Effect, Exit, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KernelLlmLive, _internal } from "../src/adapters/KernelLlm.js"
import type { CandidateRef } from "../src/lib/candidates.js"
import { LlmService } from "../src/services/LlmService.js"
import type { WikiPage } from "../src/services/VaultService.js"

const {
  extractJson,
  buildUserPrompt,
  kernelBase,
  normalizeInsights,
  effortFromEnv,
  effortConfigFor,
  effortBody,
  isOpus47Family,
  is1MContextRequested,
  stripContextSuffix,
  parseRetryAfter,
  defaultConcurrencyForModel,
  CONTEXT_1M_BETA,
} = _internal

// The Anthropic-routed tests in this file pin UBER_LLM_MODEL /
// UBER_LLM_SUMMARY_MODEL to claude-* via beforeEach so they keep exercising
// the /api/llm/messages path even though the live default is now LM Studio.
const TEST_ANTHROPIC_MODEL = "claude-opus-4-7"
const TEST_ANTHROPIC_SUMMARY_MODEL = "claude-haiku-4-5-20251001"

const page = (stem: string, body: string, topics: ReadonlyArray<string> = []): WikiPage => ({
  relPath: `input/raw/${stem}.md`,
  stem,
  frontmatter: { page_type: "source", slug: stem, topics },
  body,
  mtime: new Date("2026-04-20T12:00:00Z"),
})

const candidate = (id: string, stem: string, body: string, topics: ReadonlyArray<string> = []): CandidateRef => ({
  id,
  page: page(stem, body, topics),
  score: 0.9,
})

const anthropicJson = (jsonBlock: unknown, usage = { input_tokens: 100, output_tokens: 200 }) => ({
  model: TEST_ANTHROPIC_MODEL,
  usage,
  content: [
    {
      type: "text",
      text: `Some preamble.\n\n\`\`\`json\n${JSON.stringify(jsonBlock)}\n\`\`\`\n\nTrailing prose.`,
    },
  ],
})

describe("KernelLlm pure helpers", () => {
  it("extracts fenced JSON from text", () => {
    const out = extractJson('```json\n{"x": 1}\n```')
    expect(out).toBe('{"x": 1}')
  })

  it("falls back to curly-brace slice when no fence", () => {
    expect(extractJson('prose {"x": 1} more prose')).toBe('{"x": 1}')
  })

  it("returns null when no JSON at all", () => {
    expect(extractJson("just prose, nothing else")).toBe(null)
  })

  it("prompt includes candidates with stems, ids, and topics", () => {
    const prompt = buildUserPrompt({
      date: "2026-04-22",
      profileName: "Test",
      topics: ["alpha", "beta"],
      thesesSlugs: [],
      candidates: [
        candidate("cand-0000", "2026-04-18--foo", "Foo body text.", ["alpha"]),
        candidate("cand-0001", "2026-04-18--bar", "Bar body text.", ["beta"]),
      ],
      maxItems: 5,
    })
    expect(prompt).toContain("cand-0000")
    expect(prompt).toContain("2026-04-18--foo")
    expect(prompt).toContain("cand-0001")
    expect(prompt).toContain("topics: [alpha, beta]")
    expect(prompt).toContain("maxItems: 5")
    expect(prompt).toContain("Foo body text")
  })
})

describe("KernelLlm generateBrief (kernel-routed)", () => {
  const originalFetch = globalThis.fetch
  const prevKernel = process.env.GCTRL_KERNEL_URL
  const prevModel = process.env.UBER_LLM_MODEL
  const prevSummaryModel = process.env.UBER_LLM_SUMMARY_MODEL

  // Default to retries=0 across this suite so failure-shape assertions
  // observe the typed error directly. Tests that exercise retry behavior
  // (transient 502, 429 then 200) override this env in their setup.
  const prevRetries = process.env.UBER_LLM_RATE_LIMIT_RETRIES

  beforeEach(() => {
    process.env.GCTRL_KERNEL_URL = "http://kernel.test"
    // Pin to claude-* models so these tests exercise the Anthropic /messages
    // path. The live defaults are now LM Studio (OpenAI-compat /completions).
    process.env.UBER_LLM_MODEL = TEST_ANTHROPIC_MODEL
    process.env.UBER_LLM_SUMMARY_MODEL = TEST_ANTHROPIC_SUMMARY_MODEL
    process.env.UBER_LLM_RATE_LIMIT_RETRIES = "0"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.GCTRL_KERNEL_URL = prevKernel
    if (prevModel === undefined) delete process.env.UBER_LLM_MODEL
    else process.env.UBER_LLM_MODEL = prevModel
    if (prevSummaryModel === undefined) delete process.env.UBER_LLM_SUMMARY_MODEL
    else process.env.UBER_LLM_SUMMARY_MODEL = prevSummaryModel
    if (prevRetries === undefined) delete process.env.UBER_LLM_RATE_LIMIT_RETRIES
    else process.env.UBER_LLM_RATE_LIMIT_RETRIES = prevRetries
  })

  it("POSTs to kernel /api/llm/messages and decodes items", async () => {
    const payload = anthropicJson({
      items: [
        {
          kind: "news",
          title: "Foo happened",
          summary_md: "Important thing in [[2026-04-18--foo]].",
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

    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.generateBrief({
          date: "2026-04-22",
          profileName: "Test",
          topics: ["alpha"],
          thesesSlugs: [],
          candidates: [candidate("cand-0000", "2026-04-18--foo", "Foo body text.", ["alpha"])],
          maxItems: 3,
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )

    expect(res.items).toHaveLength(1)
    expect(res.items[0].title).toBe("Foo happened")
    expect(res.items[0].source_candidate_ids).toEqual(["cand-0000"])
    expect(res.topicsCovered).toEqual(["alpha"])
    expect(res.model).toBe(TEST_ANTHROPIC_MODEL)
    // claude-opus-4-7 → $15/$75 per Mtok.
    // 100 * $15/M input + 200 * $75/M output = $0.0015 + $0.015 = $0.0165
    expect(res.costUsd).toBeCloseTo(0.0165, 6)
    expect(res.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${kernelBase()}/api/llm/messages`)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.model).toBe(TEST_ANTHROPIC_MODEL)
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.system).toContain("uebermensch-curator")
    expect(body.messages[0].role).toBe("user")
    expect(body.messages[0].content).toContain("cand-0000")
  })

  it("opus-4.7 high effort wires adaptive thinking + output_config.effort instead of enabled+budget", async () => {
    const prevEffort = process.env.UBER_LLM_EFFORT
    process.env.UBER_LLM_EFFORT = "high"
    try {
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

      await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: ["alpha"],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )

      const [, init] = fetchMock.mock.calls[0]!
      const body = JSON.parse((init as { body: string }).body)
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.output_config).toEqual({ effort: "high" })
      // Opus 4.7 rejected `thinking.type=enabled` → make sure we don't send it.
      expect(body.thinking?.type).not.toBe("enabled")
    } finally {
      if (prevEffort === undefined) delete process.env.UBER_LLM_EFFORT
      else process.env.UBER_LLM_EFFORT = prevEffort
    }
  })

  it("model id with [1m] suffix strips the suffix on the wire and sets anthropic-beta", async () => {
    const prevModel = process.env.UBER_LLM_MODEL
    process.env.UBER_LLM_MODEL = "claude-opus-4-7[1m]"
    try {
      const payload = anthropicJson(
        { items: [], topicsCovered: [], thesesCovered: [] },
        { input_tokens: 0, output_tokens: 0 },
      )
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: [],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )

      const [, init] = fetchMock.mock.calls[0]!
      const body = JSON.parse((init as { body: string }).body)
      expect(body.model).toBe("claude-opus-4-7") // suffix stripped
      const headers = (init as { headers: Record<string, string> }).headers
      expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07")
    } finally {
      if (prevModel === undefined) delete process.env.UBER_LLM_MODEL
      else process.env.UBER_LLM_MODEL = prevModel
    }
  })

  it("transient unavailable 502 retries with exponential backoff then succeeds", async () => {
    const prevRetries = process.env.UBER_LLM_RATE_LIMIT_RETRIES
    const prevBase = process.env.UBER_LLM_RATE_LIMIT_BASE_MS
    process.env.UBER_LLM_RATE_LIMIT_RETRIES = "3"
    process.env.UBER_LLM_RATE_LIMIT_BASE_MS = "1"
    try {
      const failResponse = {
        ok: false,
        status: 502,
        text: async () => "ai gateway request failed",
      }
      const okResponse = {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(anthropicJson({
            items: [],
            topicsCovered: [],
            thesesCovered: [],
          })),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValue(okResponse)
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const res = await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: [],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      expect(res.items).toEqual([])
      expect(fetchMock.mock.calls.length).toBe(2)
    } finally {
      if (prevRetries === undefined) delete process.env.UBER_LLM_RATE_LIMIT_RETRIES
      else process.env.UBER_LLM_RATE_LIMIT_RETRIES = prevRetries
      if (prevBase === undefined) delete process.env.UBER_LLM_RATE_LIMIT_BASE_MS
      else process.env.UBER_LLM_RATE_LIMIT_BASE_MS = prevBase
    }
  })

  it("invalid 400 surfaces immediately without retrying", async () => {
    const prevRetries = process.env.UBER_LLM_RATE_LIMIT_RETRIES
    process.env.UBER_LLM_RATE_LIMIT_RETRIES = "3"
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad request",
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: [],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(fetchMock).toHaveBeenCalledOnce() // no retry on `invalid`
    } finally {
      if (prevRetries === undefined) delete process.env.UBER_LLM_RATE_LIMIT_RETRIES
      else process.env.UBER_LLM_RATE_LIMIT_RETRIES = prevRetries
    }
  })

  it("rate_limited 429 retries with small delay then succeeds", async () => {
    const prevRetries = process.env.UBER_LLM_RATE_LIMIT_RETRIES
    const prevBase = process.env.UBER_LLM_RATE_LIMIT_BASE_MS
    process.env.UBER_LLM_RATE_LIMIT_RETRIES = "3"
    process.env.UBER_LLM_RATE_LIMIT_BASE_MS = "1"
    try {
      const headerMap = new Map<string, string>([["retry-after", "0"]])
      const failResponse = {
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "tokens per minute exceeded" },
          }),
        headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
      }
      const okResponse = {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(anthropicJson({
            items: [],
            topicsCovered: [],
            thesesCovered: [],
          })),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValue(okResponse)
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const res = await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: [],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      expect(res.items).toEqual([])
      // Two failures + one success.
      expect(fetchMock.mock.calls.length).toBe(3)
    } finally {
      if (prevRetries === undefined) delete process.env.UBER_LLM_RATE_LIMIT_RETRIES
      else process.env.UBER_LLM_RATE_LIMIT_RETRIES = prevRetries
      if (prevBase === undefined) delete process.env.UBER_LLM_RATE_LIMIT_BASE_MS
      else process.env.UBER_LLM_RATE_LIMIT_BASE_MS = prevBase
    }
  })

  it("429 with Retry-After produces a typed rate_limited LlmError carrying retryAfterMs", async () => {
    const prevRetries = process.env.UBER_LLM_RATE_LIMIT_RETRIES
    // Disable retries so we observe the first failure directly. The retry
    // path is exercised separately via Schedule.recurs unit tests.
    process.env.UBER_LLM_RATE_LIMIT_RETRIES = "0"
    try {
      const headerMap = new Map<string, string>([["retry-after", "7"]])
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "tokens per minute exceeded" },
          }),
        headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: [],
            thesesSlugs: [],
            candidates: [],
            maxItems: 1,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(fetchMock).toHaveBeenCalledOnce()
      if (Exit.isFailure(exit)) {
        const failure = exit.cause
        const text = String(failure)
        expect(text).toContain("HTTP 429")
        // The LlmError should carry kind=rate_limited and retryAfterMs=7000.
        // We pull it out via Cause to assert the typed payload.
        const failOpt = Cause.failureOption(failure)
        expect(Option.isSome(failOpt)).toBe(true)
        if (Option.isSome(failOpt)) {
          const e = failOpt.value
          expect(e.kind).toBe("rate_limited")
          expect(e.retryAfterMs).toBe(7_000)
        }
      }
    } finally {
      if (prevRetries === undefined) delete process.env.UBER_LLM_RATE_LIMIT_RETRIES
      else process.env.UBER_LLM_RATE_LIMIT_RETRIES = prevRetries
    }
  })

  it("fails with unavailable when kernel returns 503", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "ANTHROPIC_API_KEY not configured",
    }) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.generateBrief({
          date: "2026-04-22",
          profileName: "Test",
          topics: [],
          thesesSlugs: [],
          candidates: [],
          maxItems: 3,
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("emits 'kernel daemon not reachable' when fetch fails with ECONNREFUSED", async () => {
    // Simulate node fetch's exact failure shape when nothing is listening on
    // GCTRL_KERNEL_URL: TypeError("fetch failed") with a nested cause
    // carrying code: "ECONNREFUSED".
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4318"), {
      code: "ECONNREFUSED",
    })
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause })
    globalThis.fetch = vi.fn().mockRejectedValue(wrapped) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.generateBrief({
          date: "2026-04-22",
          profileName: "Test",
          topics: [],
          thesesSlugs: [],
          candidates: [],
          maxItems: 3,
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const msg = String(exit.cause)
      expect(msg).toContain("kernel daemon not reachable")
      expect(msg).toContain("/api/llm/messages")
      expect(msg).toContain("gctrld serve")
    }
  })

  it("summarizeSource posts to kernel with SUMMARY_MODEL and returns insights", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: TEST_ANTHROPIC_SUMMARY_MODEL,
          usage: { input_tokens: 500, output_tokens: 200 },
          content: [
            {
              type: "text",
              text: "Here you go:\n\n## Key Insights\n\n- Tokyo lifted restrictions.\n- Sales now cover 17 allies.\n",
            },
          ],
        }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.summarizeSource({
          title: "Arms Exports",
          url: "https://example.com/arms",
          text: "long article body ".repeat(100),
          topics: ["japan-politics"],
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )

    expect(res.model).toBe(TEST_ANTHROPIC_SUMMARY_MODEL)
    expect(res.insightsMd.startsWith("## Key Insights")).toBe(true)
    expect(res.insightsMd).toContain("17 allies")
    // 500 * $1/M + 200 * $5/M = $0.0005 + $0.001 = $0.0015
    expect(res.costUsd).toBeCloseTo(0.0015, 6)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${kernelBase()}/api/llm/messages`)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.model).toBe(TEST_ANTHROPIC_SUMMARY_MODEL)
    expect(body.system).toContain("uebermensch-ingest")
    expect(body.messages[0].content).toContain("Arms Exports")
  })

  it("normalizeInsights strips preamble before the heading", () => {
    const out = normalizeInsights("Here are your insights:\n\n## Key Insights\n\n- one\n- two\n")
    expect(out.startsWith("## Key Insights")).toBe(true)
    expect(out).not.toMatch(/Here are your insights/)
  })

  it("routes @cf/* models to /api/llm/completions with OpenAI-compat body + response", async () => {
    const prevModel = process.env.UBER_LLM_MODEL
    process.env.UBER_LLM_MODEL = "@cf/google/gemma-4-26b-a4b-it"
    const openaiJson = {
      model: "@cf/google/gemma-4-26b-a4b-it",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '```json\n' +
              JSON.stringify({
                items: [
                  {
                    kind: "news",
                    title: "Gemma rendered",
                    summary_md: "Cite [[2026-04-18--foo]].",
                    topic: "alpha",
                    thesis: null,
                    source_candidate_ids: ["cand-0000"],
                    suggested_action: null,
                  },
                ],
                topicsCovered: ["alpha"],
                thesesCovered: [],
              }) +
              "\n```",
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(openaiJson),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      const res = await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: ["alpha"],
            thesesSlugs: [],
            candidates: [candidate("cand-0000", "2026-04-18--foo", "Foo body text.", ["alpha"])],
            maxItems: 3,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      expect(res.items).toHaveLength(1)
      expect(res.items[0].title).toBe("Gemma rendered")
      expect(res.model).toBe("@cf/google/gemma-4-26b-a4b-it")
      // Workers AI cost tracking deferred — reported as 0 until per-model rates land.
      expect(res.costUsd).toBe(0)
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${kernelBase()}/api/llm/completions`)
      const body = JSON.parse((init as { body: string }).body)
      expect(body.model).toBe("@cf/google/gemma-4-26b-a4b-it")
      expect(body.thinking).toBeUndefined()
      expect(body.messages[0]).toEqual({
        role: "system",
        content: expect.stringContaining("uebermensch-curator"),
      })
      expect(body.messages[1].role).toBe("user")
      expect(body.messages[1].content).toContain("cand-0000")
    } finally {
      if (prevModel === undefined) delete process.env.UBER_LLM_MODEL
      else process.env.UBER_LLM_MODEL = prevModel
    }
  })

  it("attaches x-session-id + x-service-name=uebermensch on every kernel call", async () => {
    // Capture headers fed into the kernel. The kernel reads these to
    // tag prompt_bodies + sessions for the analytics dashboard
    // (vault/specs/implementation/llm-relay.md § Convergence with
    // driver-llm). Pin UBER_SESSION_ID so the assertion is exact —
    // without it we'd just check that *some* uuid was set.
    const prevSession = process.env.UBER_SESSION_ID
    process.env.UBER_SESSION_ID = "uber-test-session-fixed"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          anthropicJson({ items: [], topicsCovered: [], thesesCovered: [] }),
        ),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LlmService
          return yield* llm.generateBrief({
            date: "2026-04-22",
            profileName: "Test",
            topics: ["alpha"],
            thesesSlugs: [],
            candidates: [],
            maxItems: 3,
          })
        }).pipe(Effect.provide(KernelLlmLive)),
      )
      const [, init] = fetchMock.mock.calls[0]!
      const headers = (init as { headers: Record<string, string> }).headers
      expect(headers["x-session-id"]).toBe("uber-test-session-fixed")
      expect(headers["x-service-name"]).toBe("uebermensch")
    } finally {
      if (prevSession === undefined) delete process.env.UBER_SESSION_ID
      else process.env.UBER_SESSION_ID = prevSession
    }
  })

  it("default model (no UBER_LLM_MODEL) routes to /api/llm/completions for LM Studio", async () => {
    // Clear the pinned anthropic model so the live default kicks in.
    delete process.env.UBER_LLM_MODEL
    const openaiJson = {
      model: "google/gemma-4-31b",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '```json\n' +
              JSON.stringify({
                items: [],
                topicsCovered: [],
                thesesCovered: [],
              }) +
              "\n```",
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 60 },
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(openaiJson),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.generateBrief({
          date: "2026-04-22",
          profileName: "Test",
          topics: [],
          thesesSlugs: [],
          candidates: [],
          maxItems: 3,
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )
    expect(res.items).toHaveLength(0)
    expect(res.costUsd).toBe(0)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${kernelBase()}/api/llm/completions`)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.model).toBe("google/gemma-4-31b")
    expect(body.thinking).toBeUndefined()
  })

  it("fails with invalid when response text has no JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: TEST_ANTHROPIC_MODEL,
          content: [{ type: "text", text: "just prose, no object here" }],
        }),
    }) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.generateBrief({
          date: "2026-04-22",
          profileName: "Test",
          topics: [],
          thesesSlugs: [],
          candidates: [],
          maxItems: 3,
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("proposeSubtopic decodes proposals and drops fabricated candidate ids", async () => {
    const payload = anthropicJson({
      proposals: [
        {
          slug: "japan-macro--boj-private-credit",
          title: "BoJ flags private-credit linkages",
          rationale: "BoJ research review highlights JP banks' BDC exposure.",
          // First id is real; second is fabricated (not in the input set).
          relevant_candidate_ids: ["cand-0000", "cand-fake"],
        },
        {
          slug: "japan-macro--takaichi-arms-exports",
          title: "Takaichi loosens lethal-arms export rules",
          rationale: "Policy shift opens defense-industrial revenue.",
          relevant_candidate_ids: ["cand-0001"],
        },
      ],
      selected_slug: "japan-macro--boj-private-credit",
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }) as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.proposeSubtopic({
          periodLabel: "2026-W18",
          periodStart: "2026-04-21",
          periodEnd: "2026-04-28",
          profileName: "Test",
          interest: {
            slug: "japan-macro",
            title: "Japan macroeconomics",
            question: "What's moving BoJ policy this week?",
            topics: ["japan-macro"],
            notes: "",
            fieldFamiliarity: "expert",
            candidates: [
              candidate("cand-0000", "2026-04-22--boj-rev26e01", "BoJ private credit body.", ["japan-macro"]),
              candidate("cand-0001", "2026-04-22--bbc-takaichi-arms", "Takaichi arms body.", ["japan-politics"]),
            ],
          },
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )

    expect(result.selectedSlug).toBe("japan-macro--boj-private-credit")
    expect(result.proposals).toHaveLength(2)
    // Fabricated id was dropped, real one retained.
    expect(result.proposals[0].relevantCandidateIds).toEqual(["cand-0000"])
    expect(result.proposals[1].relevantCandidateIds).toEqual(["cand-0001"])
  })

  it("proposeSubtopic falls back to first proposal when selected_slug is unknown", async () => {
    const payload = anthropicJson({
      proposals: [
        {
          slug: "real-slug",
          title: "Real",
          rationale: "ok",
          relevant_candidate_ids: ["cand-0000"],
        },
      ],
      selected_slug: "hallucinated-slug-not-in-proposals",
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }) as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LlmService
        return yield* llm.proposeSubtopic({
          periodLabel: "2026-W18",
          periodStart: "2026-04-21",
          periodEnd: "2026-04-28",
          profileName: "Test",
          interest: {
            slug: "japan-macro",
            title: "Japan macroeconomics",
            question: null,
            topics: ["japan-macro"],
            notes: "",
            fieldFamiliarity: "expert",
            candidates: [candidate("cand-0000", "stem", "body", ["japan-macro"])],
          },
        })
      }).pipe(Effect.provide(KernelLlmLive)),
    )

    expect(result.selectedSlug).toBe("real-slug")
  })

  describe("effort tier mapping", () => {
    const prevEffort = process.env.UBER_LLM_EFFORT

    afterEach(() => {
      if (prevEffort === undefined) delete process.env.UBER_LLM_EFFORT
      else process.env.UBER_LLM_EFFORT = prevEffort
    })

    it("default effort is medium with adaptive thinking and 16k tokens", () => {
      delete process.env.UBER_LLM_EFFORT
      const cfg = effortConfigFor(effortFromEnv())
      expect(cfg.maxTokens).toBe(16000)
      expect(cfg.thinking).toBe("adaptive")
    })

    it("low effort caps tokens to 4k and disables thinking", () => {
      process.env.UBER_LLM_EFFORT = "low"
      const cfg = effortConfigFor(effortFromEnv())
      expect(cfg.maxTokens).toBe(4000)
      expect(cfg.thinking).toBe("off")
    })

    it("high effort doubles to 32k tokens with extended thinking budget", () => {
      process.env.UBER_LLM_EFFORT = "high"
      const cfg = effortConfigFor(effortFromEnv())
      expect(cfg.maxTokens).toBe(32000)
      expect(cfg.thinking).toBe("extended")
      expect(cfg.thinkingBudgetTokens).toBeGreaterThan(0)
    })

    it("invalid UBER_LLM_EFFORT falls back to medium", () => {
      process.env.UBER_LLM_EFFORT = "ludicrous"
      expect(effortFromEnv()).toBe("medium")
    })

    it("opus-4.7 high effort uses adaptive thinking + output_config.effort=high (not enabled+budget)", () => {
      process.env.UBER_LLM_EFFORT = "high"
      const cfg = effortConfigFor(effortFromEnv(), "claude-opus-4-7")
      expect(cfg.maxTokens).toBe(32000)
      expect(cfg.thinking).toBe("adaptive")
      expect(cfg.outputEffort).toBe("high")
      const body = effortBody(cfg)
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.output_config).toEqual({ effort: "high" })
    })

    it("opus-4.7 medium effort still emits output_config.effort", () => {
      delete process.env.UBER_LLM_EFFORT
      const cfg = effortConfigFor(effortFromEnv(), "claude-opus-4-7")
      expect(cfg.thinking).toBe("adaptive")
      expect(cfg.outputEffort).toBe("medium")
    })

    it("opus-4.6 high effort keeps the legacy enabled+budget shape", () => {
      process.env.UBER_LLM_EFFORT = "high"
      const cfg = effortConfigFor(effortFromEnv(), "claude-opus-4-6")
      expect(cfg.thinking).toBe("extended")
      expect(cfg.thinkingBudgetTokens).toBeGreaterThan(0)
      expect(cfg.outputEffort).toBeUndefined()
      const body = effortBody(cfg)
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 })
      expect(body.output_config).toBeUndefined()
    })

    it("opus-4.7 with [1m] suffix is still routed through the 4.7 effort path", () => {
      process.env.UBER_LLM_EFFORT = "high"
      const cfg = effortConfigFor(effortFromEnv(), "claude-opus-4-7[1m]")
      expect(cfg.thinking).toBe("adaptive")
      expect(cfg.outputEffort).toBe("high")
    })
  })

  describe("model id helpers", () => {
    it("isOpus47Family matches 4.7 with or without context suffix and rejects older opus", () => {
      expect(isOpus47Family("claude-opus-4-7")).toBe(true)
      expect(isOpus47Family("claude-opus-4-7-20260101")).toBe(true)
      expect(isOpus47Family("claude-opus-4-7[1m]")).toBe(true)
      expect(isOpus47Family("claude-opus-4-6")).toBe(false)
      expect(isOpus47Family("claude-sonnet-4-6")).toBe(false)
    })

    it("stripContextSuffix removes the [1m] suffix only", () => {
      expect(stripContextSuffix("claude-opus-4-7[1m]")).toBe("claude-opus-4-7")
      expect(stripContextSuffix("claude-opus-4-7")).toBe("claude-opus-4-7")
      expect(stripContextSuffix("@cf/google/gemma-4-31b")).toBe("@cf/google/gemma-4-31b")
    })

    it("is1MContextRequested honors the [1m] suffix and UBER_LLM_CONTEXT_1M env", () => {
      const prev = process.env.UBER_LLM_CONTEXT_1M
      try {
        delete process.env.UBER_LLM_CONTEXT_1M
        expect(is1MContextRequested("claude-opus-4-7")).toBe(false)
        expect(is1MContextRequested("claude-opus-4-7[1m]")).toBe(true)
        process.env.UBER_LLM_CONTEXT_1M = "1"
        expect(is1MContextRequested("claude-opus-4-7")).toBe(true)
        process.env.UBER_LLM_CONTEXT_1M = "yes"
        expect(is1MContextRequested("claude-opus-4-7")).toBe(true)
        process.env.UBER_LLM_CONTEXT_1M = "0"
        expect(is1MContextRequested("claude-opus-4-7")).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.UBER_LLM_CONTEXT_1M
        else process.env.UBER_LLM_CONTEXT_1M = prev
      }
    })

    it("CONTEXT_1M_BETA matches the documented beta slug", () => {
      expect(CONTEXT_1M_BETA).toBe("context-1m-2025-08-07")
    })

    it("defaultConcurrencyForModel picks tight values for opus-4.7 and looser for sonnet/haiku", () => {
      expect(defaultConcurrencyForModel(undefined)).toBe(2)
      expect(defaultConcurrencyForModel("claude-opus-4-7")).toBe(1)
      expect(defaultConcurrencyForModel("claude-opus-4-7[1m]")).toBe(1)
      expect(defaultConcurrencyForModel("claude-opus-4-6")).toBe(2)
      expect(defaultConcurrencyForModel("claude-sonnet-4-6")).toBe(4)
      expect(defaultConcurrencyForModel("claude-haiku-4-5")).toBe(6)
      expect(defaultConcurrencyForModel("@cf/google/gemma-4-31b")).toBe(2)
    })
  })

  describe("parseRetryAfter", () => {
    it("parses delta-seconds and clamps absurd values", () => {
      expect(parseRetryAfter("5")).toBe(5000)
      expect(parseRetryAfter("0.5")).toBe(500)
      expect(parseRetryAfter("3600")).toBe(120_000) // clamped
      expect(parseRetryAfter("0")).toBe(0)
    })

    it("parses HTTP-date and returns positive ms-from-now", () => {
      const future = new Date(Date.now() + 7000).toUTCString()
      const ms = parseRetryAfter(future)
      expect(ms).not.toBeNull()
      // Allow generous slop for execution time between Date.now() reads.
      expect(ms!).toBeGreaterThan(2000)
      expect(ms!).toBeLessThanOrEqual(120_000)
    })

    it("returns 0 for past HTTP-date and null for garbage", () => {
      const past = new Date(Date.now() - 5000).toUTCString()
      expect(parseRetryAfter(past)).toBe(0)
      expect(parseRetryAfter("nope")).toBeNull()
      expect(parseRetryAfter(null)).toBeNull()
      expect(parseRetryAfter(undefined)).toBeNull()
      expect(parseRetryAfter("")).toBeNull()
    })
  })
})
