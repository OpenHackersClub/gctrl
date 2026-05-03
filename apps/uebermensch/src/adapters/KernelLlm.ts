import { Agent } from "undici"
import { Duration, Effect, Layer } from "effect"
import type { LlmError } from "../errors.js"

// Constrained decoding under `response_format: json_schema` can run for many
// minutes on local backends (LMStudio + gemma) when the target schema has
// long markdown fields. Node's built-in fetch (undici) caps headers/body at
// 5 min; long single-shot completions hit that and surface as `TypeError:
// fetch failed`. Pass an undici Agent with timeouts disabled per request via
// the `dispatcher` option so the LLM stage isn't artificially capped — global
// fetch behavior is unchanged, so tests that mock `globalThis.fetch` and
// other consumers of fetch are unaffected.
const llmFetchAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

import {
  buildInterestReportUserPrompt,
  buildResearchQueryUserPrompt,
  buildSubtopicUserPrompt,
  buildSummaryUserPrompt,
  buildUserPrompt,
  extractJson,
  InterestReportOutputSchema,
  type JsonResponseFormat,
  LlmOutputSchema,
  normalizeInsights,
  REPORT_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  SUBTOPIC_SYSTEM_PROMPT,
  SubtopicProposeOutputSchema,
  SUMMARY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "../lib/llm-prompts.js"
import { makeLlmServiceShape } from "../lib/llm-service-factory.js"
import {
  type AnthropicResponse,
  classifyHttpStatus,
  CONTEXT_1M_BETA,
  defaultConcurrencyForModel,
  effortBody,
  type EffortConfig,
  effortConfigFor,
  effortFromEnv,
  isAnthropicModel,
  isConnRefused,
  is1MContextRequested,
  isOpus47Family,
  isWorkersAiModel,
  llmErr,
  type NormalizedResponse,
  type OpenAiChatResponse,
  parseRetryAfter,
  SERVICE_NAME,
  sessionIdFor,
  stripContextSuffix,
} from "../lib/llm-shared.js"
import { LlmService } from "../services/LlmService.js"

// Local-first default: kernel /api/llm/completions routes to LM Studio at
// 127.0.0.1:1234 unless GCTRL_LLM_PROVIDER=cloudflare is set on the kernel.
// Override with UBER_LLM_MODEL to match the model id loaded in your LM Studio
// instance (LM Studio typically echoes whatever model name it has loaded).
const DEFAULT_MODEL = "google/gemma-4-31b"

// Per-article summarization shares the curator default by design — LM Studio
// typically has a single model loaded and echoes that name regardless of the
// `model` field. Override with UBER_LLM_SUMMARY_MODEL when running a separate
// smaller model on a second backend.
const DEFAULT_SUMMARY_MODEL = "google/gemma-4-31b"

const modelFor = (): string => process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL

const summaryModelFor = (): string =>
  process.env.UBER_LLM_SUMMARY_MODEL ?? process.env.UBER_LLM_MODEL ?? DEFAULT_SUMMARY_MODEL

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const kernelDownErr = (path: string): LlmError =>
  llmErr(
    "unavailable",
    `kernel daemon not reachable at ${kernelBase()}${path} — start it with: ` +
      `gctrld serve --port 4318 (or set GCTRL_KERNEL_URL to point at a running kernel)`,
  )

// POST a JSON body to `${kernelBase()}${path}` and return the raw response
// text. Connection-level failures (ECONNREFUSED etc.) become a "kernel daemon
// not reachable" hint; non-2xx responses become a classified LlmError.
// `extraHeaders` lets callers forward request-shaping headers like
// `anthropic-beta` (the kernel's /api/llm/messages re-emits them upstream).
const fetchKernel = (
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Effect.Effect<string, LlmError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${kernelBase()}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-id": sessionIdFor(),
            "x-service-name": SERVICE_NAME,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
          // Non-standard undici option — silently ignored if a test replaces
          // globalThis.fetch with a non-undici mock.
          dispatcher: llmFetchAgent,
          // biome-ignore lint/suspicious/noExplicitAny: undici-specific option
        } as any),
      catch: (e) => {
        if (isConnRefused(e)) return kernelDownErr(path)
        const cause = (e as { cause?: unknown })?.cause
        const causeStr = cause ? ` cause=${String(cause)}` : ""
        return llmErr("unavailable", `kernel ${path} fetch failed: ${String(e)}${causeStr}`)
      },
    })
    const raw = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        llmErr("unavailable", `kernel ${path} body read failed: ${String(e)}`),
    })
    if (!res.ok) {
      const kind = classifyHttpStatus(res.status)
      let retryAfterMs: number | undefined
      if (kind === "rate_limited") {
        // Headers may be unavailable on test mocks — guard the lookup.
        const headerGet = (k: string): string | null => {
          try {
            return res.headers?.get?.(k) ?? null
          } catch {
            return null
          }
        }
        const ra =
          parseRetryAfter(headerGet("retry-after")) ??
          // Anthropic also sends `anthropic-ratelimit-input-tokens-reset`
          // as an ISO-8601 timestamp. Honor it as a fallback so paced
          // retries don't hammer the upstream early.
          parseRetryAfter(headerGet("anthropic-ratelimit-input-tokens-reset")) ??
          parseRetryAfter(headerGet("anthropic-ratelimit-tokens-reset"))
        if (ra !== null) retryAfterMs = ra
      }
      return yield* Effect.fail(
        llmErr(
          kind,
          `kernel ${path} HTTP ${res.status}: ${raw.slice(0, 500)}`,
          retryAfterMs,
        ),
      )
    }
    return raw
  })

// Bounded retry loop for transient LlmErrors. Two kinds qualify:
//   - `rate_limited` (HTTP 429): honors `retryAfterMs` when present,
//     otherwise exponential backoff capped at MAX_MS.
//   - `unavailable`  (HTTP 502/503 + connection failures): exponential
//     backoff only — upstream doesn't supply a hint.
// `invalid` (4xx other than 429) propagates immediately so a malformed
// request surfaces fast.
//
// Knobs (env, all optional):
//   UBER_LLM_RATE_LIMIT_RETRIES  attempts after the first failure (default 4)
//   UBER_LLM_RATE_LIMIT_BASE_MS  base delay for exponential backoff (default 2000)
//   UBER_LLM_RATE_LIMIT_MAX_MS   ceiling delay (default 60000)
// Setting RETRIES=0 disables retry entirely — the typed `LlmError`
// surfaces directly to the caller (used by tests).
const envInt = (key: string, fallback: number, min = 0): number => {
  const raw = process.env[key]
  if (raw === undefined || raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

type RateLimitConfig = {
  readonly maxRetries: number
  readonly baseMs: number
  readonly maxMs: number
}

const rateLimitConfig = (): RateLimitConfig => ({
  maxRetries: envInt("UBER_LLM_RATE_LIMIT_RETRIES", 4),
  baseMs: envInt("UBER_LLM_RATE_LIMIT_BASE_MS", 2_000, 1),
  maxMs: envInt("UBER_LLM_RATE_LIMIT_MAX_MS", 60_000, 1),
})

const isTransientKind = (kind: LlmError["kind"]): boolean =>
  kind === "rate_limited" || kind === "unavailable"

const withRateLimitRetry = <A>(
  eff: Effect.Effect<A, LlmError>,
): Effect.Effect<A, LlmError> => {
  const cfg = rateLimitConfig()
  const loop = (attempt: number): Effect.Effect<A, LlmError> =>
    eff.pipe(
      Effect.catchTag("LlmError", (e) => {
        if (!isTransientKind(e.kind) || attempt >= cfg.maxRetries) {
          return Effect.fail(e)
        }
        const expBackoff = Math.min(cfg.baseMs * 2 ** attempt, cfg.maxMs)
        // 429 supplies retryAfterMs; 5xx does not — fall back to
        // exponential. Cap the hint at MAX_MS too so a buggy upstream
        // can't stall a run.
        const hint = e.retryAfterMs
        const delayMs =
          hint !== undefined ? Math.min(hint, cfg.maxMs) : expBackoff
        return Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(loop(attempt + 1)),
        )
      }),
    )
  return loop(0)
}

const postAnthropic = (
  model: string,
  system: string,
  userPrompt: string,
  cfg: EffortConfig,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.gen(function* () {
    const wireModel = stripContextSuffix(model)
    const body: Record<string, unknown> = {
      model: wireModel,
      max_tokens: cfg.maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
      ...effortBody(cfg),
    }
    const headers: Record<string, string> = {}
    if (is1MContextRequested(model)) headers["anthropic-beta"] = CONTEXT_1M_BETA
    const raw = yield* fetchKernel("/api/llm/messages", body, headers)
    const parsed = yield* Effect.try({
      try: () =>
        (raw.length > 0 ? (JSON.parse(raw) as AnthropicResponse) : ({} as AnthropicResponse)),
      catch: (e) =>
        llmErr("invalid", `kernel /api/llm/messages JSON.parse failed: ${String(e)}`),
    })
    const textBlock = (parsed.content ?? []).find(
      (b): b is { type: string; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    if (!textBlock) {
      return yield* Effect.fail(
        llmErr("invalid", "kernel response missing text content block"),
      )
    }
    return {
      text: textBlock.text,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      model: parsed.model ?? wireModel,
    }
  })

const postWorkersAi = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  jsonFormat: JsonResponseFormat | null,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.gen(function* () {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      ...(jsonFormat
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: jsonFormat.name,
                strict: true,
                schema: jsonFormat.schema,
              },
            },
          }
        : {}),
    }
    const raw = yield* fetchKernel("/api/llm/completions", body)
    const parsed = yield* Effect.try({
      try: () =>
        (raw.length > 0 ? (JSON.parse(raw) as OpenAiChatResponse) : ({} as OpenAiChatResponse)),
      catch: (e) =>
        llmErr("invalid", `kernel /api/llm/completions JSON.parse failed: ${String(e)}`),
    })
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      return yield* Effect.fail(
        llmErr("invalid", "kernel response missing choices[0].message.content string"),
      )
    }
    return {
      text: content,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      model: parsed.model ?? model,
    }
  })

// Anthropic-shaped models go through /api/llm/messages (with rate-limit retry).
// Everything else (`@cf/...` Workers AI, locally-served OpenAI-compat backends
// like LM Studio / Ollama) goes through /api/llm/completions.
const postLlm = (
  model: string,
  system: string,
  userPrompt: string,
  cfg: EffortConfig,
  jsonFormat: JsonResponseFormat | null,
): Effect.Effect<NormalizedResponse, LlmError> =>
  withRateLimitRetry(
    isWorkersAiModel(model)
      ? postWorkersAi(model, system, userPrompt, cfg.maxTokens, jsonFormat)
      : postAnthropic(model, system, userPrompt, cfg),
  )

export const KernelLlmLive = Layer.succeed(
  LlmService,
  makeLlmServiceShape({
    name: () => `kernel-llm@${modelFor()}`,
    postLlm,
    modelFor,
    summaryModelFor,
  }),
)

// Re-export prompt/schema material for tests that historically reach into
// `_internal`. Tests should migrate to importing directly from
// `lib/llm-prompts.ts`, but keeping the shape stable here avoids touching
// every test in this PR.
export const _internal = {
  buildUserPrompt,
  buildInterestReportUserPrompt,
  buildSubtopicUserPrompt,
  buildSummaryUserPrompt,
  buildResearchQueryUserPrompt,
  extractJson,
  kernelBase,
  LlmOutputSchema,
  InterestReportOutputSchema,
  SubtopicProposeOutputSchema,
  normalizeInsights,
  SYSTEM_PROMPT,
  REPORT_SYSTEM_PROMPT,
  SUBTOPIC_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  MODEL: DEFAULT_MODEL,
  DEFAULT_MODEL,
  SUMMARY_MODEL: DEFAULT_SUMMARY_MODEL,
  DEFAULT_SUMMARY_MODEL,
  modelFor,
  summaryModelFor,
  sessionIdFor,
  SERVICE_NAME,
  isAnthropicModel,
  isWorkersAiModel,
  effortFromEnv,
  effortConfigFor,
  effortBody,
  isOpus47Family,
  is1MContextRequested,
  stripContextSuffix,
  parseRetryAfter,
  defaultConcurrencyForModel,
  CONTEXT_1M_BETA,
}
