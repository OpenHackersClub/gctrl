import Anthropic, {
  APIError,
  AuthenticationError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk"
import { Context, Effect, Layer } from "effect"
import { LlmError } from "../errors.js"
import { CURATOR_SYSTEM_PREAMBLE, renderUserPrompt } from "../lib/curator-prompt.js"
import { sha256 } from "../lib/hash.js"
import { LlmService } from "../services/LlmService.js"
import type { CuratedItem } from "../services/RendererService.js"

export type AnthropicLlmConfig = {
  readonly apiKey: string
  readonly model: string
  readonly maxOutputTokens: number
  readonly fetch?: typeof fetch
  readonly maxRetries?: number
}

export class AnthropicLlmConfigTag extends Context.Tag("uebermensch/AnthropicLlmConfig")<
  AnthropicLlmConfigTag,
  AnthropicLlmConfig
>() {}

const DEFAULT_MODEL = "claude-sonnet-4-6"
const DEFAULT_MAX_OUTPUT_TOKENS = 4096

const PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

const computeCostUsd = (model: string, usage: Usage): number => {
  const p = PRICING_USD_PER_MTOK[model]
  if (!p) return 0
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cost =
    (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
    1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

const stripJsonFences = (s: string): string => {
  const trimmed = s.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed)
  const inner = fence?.[1]
  return inner !== undefined ? inner.trim() : trimmed
}

type RawItem = {
  kind?: unknown
  title?: unknown
  summary_md?: unknown
  topic?: unknown
  thesis?: unknown
  source_candidate_ids?: unknown
  suggested_action?: unknown
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null)

const asStringArray = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

const ALLOWED_KINDS: ReadonlyArray<CuratedItem["kind"]> = ["news", "update", "action", "alert"]

const normaliseItem = (raw: RawItem): CuratedItem | null => {
  const kindStr = asString(raw.kind)
  const kind = ALLOWED_KINDS.find((k) => k === kindStr) ?? "news"
  const title = asString(raw.title)
  const summary = asString(raw.summary_md)
  if (!title || !summary) return null
  return {
    kind,
    title,
    summary_md: summary,
    topic: asString(raw.topic),
    thesis: asString(raw.thesis),
    source_candidate_ids: asStringArray(raw.source_candidate_ids),
    suggested_action: asString(raw.suggested_action),
  }
}

const parseResponse = (text: string): ReadonlyArray<CuratedItem> => {
  const stripped = stripJsonFences(text)
  const parsed: unknown = JSON.parse(stripped)
  if (!parsed || typeof parsed !== "object") {
    throw new Error("curator returned non-object JSON")
  }
  const itemsRaw = (parsed as { items?: unknown }).items
  if (!Array.isArray(itemsRaw)) {
    throw new Error("curator returned no items[] array")
  }
  const items: Array<CuratedItem> = []
  for (const raw of itemsRaw) {
    if (raw && typeof raw === "object") {
      const item = normaliseItem(raw as RawItem)
      if (item) items.push(item)
    }
  }
  return items
}

const mapSdkError = (err: unknown): LlmError => {
  if (err instanceof RateLimitError) {
    return new LlmError({ message: err.message, kind: "rate_limited" })
  }
  if (err instanceof AuthenticationError || err instanceof BadRequestError) {
    return new LlmError({ message: err.message, kind: "invalid" })
  }
  if (err instanceof APIError) {
    return new LlmError({ message: err.message, kind: "unavailable" })
  }
  if (err instanceof SyntaxError) {
    return new LlmError({ message: `curator JSON parse failed: ${err.message}`, kind: "invalid" })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new LlmError({ message, kind: "unavailable" })
}

export const AnthropicLlmLive = Layer.effect(
  LlmService,
  Effect.gen(function* () {
    const config = yield* AnthropicLlmConfigTag
    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    })
    return {
      name: () => `anthropic:${config.model}`,
      generateBrief: (req) =>
        Effect.gen(function* () {
          const userPrompt = renderUserPrompt({
            date: req.date,
            profileName: req.profileName,
            topics: req.topics,
            thesesSlugs: req.thesesSlugs,
            candidates: req.candidates,
            maxItems: req.maxItems,
          })
          const promptHash = sha256(`${CURATOR_SYSTEM_PREAMBLE}\n\n${userPrompt}`)
          const candidateIds = new Set(req.candidates.map((c) => c.id))

          const response = yield* Effect.tryPromise({
            try: () =>
              client.messages.create({
                model: config.model,
                max_tokens: config.maxOutputTokens,
                system: [
                  {
                    type: "text",
                    text: CURATOR_SYSTEM_PREAMBLE,
                    cache_control: { type: "ephemeral" },
                  },
                ],
                messages: [{ role: "user", content: userPrompt }],
              }),
            catch: mapSdkError,
          })

          const textBlock = response.content.find(
            (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
          )
          if (!textBlock) {
            return yield* Effect.fail(
              new LlmError({ message: "curator returned no text block", kind: "invalid" }),
            )
          }
          const items = yield* Effect.try({
            try: () => parseResponse(textBlock.text),
            catch: mapSdkError,
          })

          // Drop fabricated source IDs — the strict renderer would reject the brief otherwise,
          // and aborting here gives a clearer error surface.
          const sanitised: ReadonlyArray<CuratedItem> = items.map((it) => ({
            ...it,
            source_candidate_ids: it.source_candidate_ids.filter((id) => candidateIds.has(id)),
          }))

          const topicsCovered = Array.from(
            new Set(
              sanitised
                .map((i) => i.topic)
                .filter((t): t is string => t !== null && req.topics.includes(t)),
            ),
          )
          const thesesCovered = Array.from(
            new Set(
              sanitised
                .map((i) => i.thesis)
                .filter((t): t is string => t !== null && req.thesesSlugs.includes(t)),
            ),
          )

          return {
            items: sanitised,
            topicsCovered,
            thesesCovered,
            promptHash,
            costUsd: computeCostUsd(config.model, response.usage),
            model: config.model,
          }
        }),
    }
  }),
)

export const AnthropicLlmConfigFromEnv = Layer.effect(
  AnthropicLlmConfigTag,
  Effect.sync(() => {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY env var is required for UBER_LLM_PROVIDER=anthropic")
    }
    const model = process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL
    const maxTokensRaw = process.env.UBER_LLM_MAX_OUTPUT_TOKENS
    const maxOutputTokens =
      maxTokensRaw && Number.isFinite(Number(maxTokensRaw))
        ? Number(maxTokensRaw)
        : DEFAULT_MAX_OUTPUT_TOKENS
    return { apiKey, model, maxOutputTokens }
  }),
)

export const AnthropicLlmFromEnvLive = AnthropicLlmLive.pipe(
  Layer.provide(AnthropicLlmConfigFromEnv),
)
