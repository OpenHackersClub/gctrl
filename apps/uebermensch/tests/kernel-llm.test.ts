import { Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KernelLlmLive, _internal } from "../src/adapters/KernelLlm.js"
import type { CandidateRef } from "../src/lib/candidates.js"
import { LlmService } from "../src/services/LlmService.js"
import type { WikiPage } from "../src/services/VaultService.js"

const { extractJson, buildUserPrompt, kernelBase, MODEL } = _internal

const page = (stem: string, body: string, topics: ReadonlyArray<string> = []): WikiPage => ({
  relPath: `wiki/sources/${stem}.md`,
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
  model: MODEL,
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

  beforeEach(() => {
    process.env.GCTRL_KERNEL_URL = "http://kernel.test"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.GCTRL_KERNEL_URL = prevKernel
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
    expect(res.model).toBe(MODEL)
    // 100 * $5/M input + 200 * $25/M output = $0.0005 + $0.005 = $0.0055
    expect(res.costUsd).toBeCloseTo(0.0055, 6)
    expect(res.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${kernelBase()}/api/llm/messages`)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.model).toBe(MODEL)
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.system).toContain("uebermensch-curator")
    expect(body.messages[0].role).toBe("user")
    expect(body.messages[0].content).toContain("cand-0000")
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

  it("fails with invalid when response text has no JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: MODEL,
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
})
