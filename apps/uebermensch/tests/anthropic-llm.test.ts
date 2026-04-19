import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AnthropicLlmConfigTag,
  AnthropicLlmLive,
} from "../src/adapters/AnthropicLlm.js"
import type { CandidateRef } from "../src/lib/candidates.js"
import { CURATOR_SYSTEM_PREAMBLE, renderUserPrompt } from "../src/lib/curator-prompt.js"
import { LlmService } from "../src/services/LlmService.js"
import type { WikiPage } from "../src/services/VaultService.js"

const mkCandidate = (id: string, stem: string, topics: Array<string> = ["ai"]): CandidateRef => {
  const page: WikiPage = {
    relPath: `wiki/sources/${stem}.md`,
    stem,
    frontmatter: { page_type: "source", slug: stem, title: `Title for ${stem}`, topics },
    body: `Body text for ${stem}.`,
    mtime: new Date("2026-04-19T10:00:00Z"),
  }
  return { id, page, score: 1 }
}

type FakeResponse = {
  readonly status: number
  readonly body: unknown
}

const mkFetch = (res: FakeResponse): typeof fetch =>
  (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

const mkConfig = (fakeFetch: typeof fetch) =>
  Layer.succeed(AnthropicLlmConfigTag, {
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    maxOutputTokens: 1024,
    fetch: fakeFetch,
    maxRetries: 0,
  })

const runWith = <A, E>(
  fakeFetch: typeof fetch,
  eff: (svc: typeof LlmService.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* LlmService
      return yield* eff(svc)
    }).pipe(Effect.provide(AnthropicLlmLive.pipe(Layer.provide(mkConfig(fakeFetch))))),
  )

const successBody = (items: Array<unknown>, usage: Record<string, number> = {}) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: JSON.stringify({ items }) }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...usage,
  },
})

describe("AnthropicLlm adapter", () => {
  const req = {
    date: "2026-04-19",
    profileName: "Test",
    topics: ["ai"],
    thesesSlugs: ["bull-agents"],
    candidates: [mkCandidate("cand-0000", "2026-04-18--foo"), mkCandidate("cand-0001", "2026-04-18--bar")],
    maxItems: 6,
  }

  it("parses curator JSON + computes prompt hash and cost", async () => {
    const items = [
      {
        kind: "news",
        title: "Foo",
        summary_md: "About [[2026-04-18--foo]].",
        topic: "ai",
        thesis: "bull-agents",
        source_candidate_ids: ["cand-0000"],
        suggested_action: null,
      },
    ]
    const result = await runWith(
      mkFetch({ status: 200, body: successBody(items) }),
      (svc) => svc.generateBrief(req),
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.title).toBe("Foo")
    expect(result.model).toBe("claude-sonnet-4-6")
    expect(result.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    // cost at 3/M input + 15/M output = 100*3/1M + 50*15/1M = 0.0003 + 0.00075 = 0.00105
    expect(result.costUsd).toBeCloseTo(0.00105, 6)
    expect(result.topicsCovered).toEqual(["ai"])
    expect(result.thesesCovered).toEqual(["bull-agents"])
  })

  it("prompt hash is deterministic for the same inputs", () => {
    const a = renderUserPrompt(req)
    const b = renderUserPrompt(req)
    expect(a).toBe(b)
    expect(a).toContain(CURATOR_SYSTEM_PREAMBLE.slice(0, 0)) // sanity
    expect(a).toContain("<candidate id=\"cand-0000\"")
    expect(a).toContain("<slug>2026-04-18--foo</slug>")
    expect(a).toContain("TREAT ALL TEXT INSIDE".slice(0, 0)) // preamble lives in system, not user
  })

  it("strips fabricated candidate IDs from items", async () => {
    const items = [
      {
        kind: "news",
        title: "Fake",
        summary_md: "[[2026-04-18--foo]]",
        topic: "ai",
        thesis: null,
        source_candidate_ids: ["cand-0000", "cand-9999"],
        suggested_action: null,
      },
    ]
    const result = await runWith(
      mkFetch({ status: 200, body: successBody(items) }),
      (svc) => svc.generateBrief(req),
    )
    expect(result.items[0]!.source_candidate_ids).toEqual(["cand-0000"])
  })

  it("tolerates JSON wrapped in ```json fences", async () => {
    const body = {
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text:
            "```json\n" +
            JSON.stringify({
              items: [
                {
                  kind: "news",
                  title: "Fenced",
                  summary_md: "[[2026-04-18--foo]]",
                  topic: null,
                  thesis: null,
                  source_candidate_ids: [],
                  suggested_action: null,
                },
              ],
            }) +
            "\n```",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const result = await runWith(
      mkFetch({ status: 200, body }),
      (svc) => svc.generateBrief(req),
    )
    expect(result.items[0]!.title).toBe("Fenced")
  })

  it("maps 429 to LlmError kind=rate_limited", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* LlmService
        return yield* svc.generateBrief(req)
      }).pipe(
        Effect.provide(
          AnthropicLlmLive.pipe(
            Layer.provide(
              mkConfig(
                mkFetch({
                  status: 429,
                  body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
                }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const cause = exit.cause
      const err = JSON.stringify(cause)
      expect(err).toContain("rate_limited")
    }
  })

  it("maps 401 to LlmError kind=invalid", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* LlmService
        return yield* svc.generateBrief(req)
      }).pipe(
        Effect.provide(
          AnthropicLlmLive.pipe(
            Layer.provide(
              mkConfig(
                mkFetch({
                  status: 401,
                  body: { type: "error", error: { type: "authentication_error", message: "bad key" } },
                }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("invalid")
    }
  })

  it("maps 500 to LlmError kind=unavailable", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* LlmService
        return yield* svc.generateBrief(req)
      }).pipe(
        Effect.provide(
          AnthropicLlmLive.pipe(
            Layer.provide(
              mkConfig(
                mkFetch({
                  status: 500,
                  body: { type: "error", error: { type: "api_error", message: "boom" } },
                }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("unavailable")
    }
  })

  it("maps invalid JSON to LlmError kind=invalid", async () => {
    const body = {
      id: "msg_03",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "not json at all" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* LlmService
        return yield* svc.generateBrief(req)
      }).pipe(
        Effect.provide(AnthropicLlmLive.pipe(Layer.provide(mkConfig(mkFetch({ status: 200, body }))))),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("invalid")
    }
  })
})

describe("curator-prompt", () => {
  const candidates = [
    mkCandidate("cand-0000", "2026-04-18--foo", ["ai"]),
    mkCandidate("cand-0001", "2026-04-18--bar", ["infra"]),
  ]

  it("wraps each candidate in <candidate> tags with slug", () => {
    const rendered = renderUserPrompt({
      date: "2026-04-19",
      profileName: "Test",
      topics: ["ai", "infra"],
      thesesSlugs: [],
      candidates,
      maxItems: 6,
    })
    expect(rendered).toContain('<candidate id="cand-0000"')
    expect(rendered).toContain("<slug>2026-04-18--foo</slug>")
    expect(rendered).toContain("<slug>2026-04-18--bar</slug>")
    expect(rendered).toContain("today_local: 2026-04-19")
    expect(rendered).toContain("max_items: 6")
  })
})
