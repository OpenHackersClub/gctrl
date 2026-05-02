import { Agent } from "undici"
import { Effect, Layer } from "effect"
import { LlmError } from "../errors.js"

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
  effortConfigFor,
  effortFromEnv,
  isAnthropicModel,
  isConnRefused,
  isOpenAiCompatModel,
  isWorkersAiModel,
  llmErr,
  type NormalizedResponse,
  type OpenAiChatResponse,
  SERVICE_NAME,
  sessionIdFor,
  type ThinkingMode,
  thinkingBody,
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
const fetchKernel = (
  path: string,
  body: unknown,
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
      return yield* Effect.fail(
        llmErr(
          classifyHttpStatus(res.status),
          `kernel ${path} HTTP ${res.status}: ${raw.slice(0, 500)}`,
        ),
      )
    }
    return raw
  })

const postAnthropic = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  thinking: ThinkingMode,
  thinkingBudgetTokens: number,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.gen(function* () {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
      ...thinkingBody(thinking, thinkingBudgetTokens),
    }
    const raw = yield* fetchKernel("/api/llm/messages", body)
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
      model: parsed.model ?? model,
    }
  })

const postOpenAiCompat = (
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

// Anthropic-shaped models go through /api/llm/messages. Everything else
// (`@cf/...` Workers AI, locally-served OpenAI-compat backends like
// LM Studio / Ollama) goes through /api/llm/completions.
const postLlm = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  thinking: ThinkingMode,
  thinkingBudgetTokens: number,
  jsonFormat: JsonResponseFormat | null,
): Effect.Effect<NormalizedResponse, LlmError> =>
  isOpenAiCompatModel(model)
    ? postOpenAiCompat(model, system, userPrompt, maxTokens, jsonFormat)
    : postAnthropic(model, system, userPrompt, maxTokens, thinking, thinkingBudgetTokens)

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
}
