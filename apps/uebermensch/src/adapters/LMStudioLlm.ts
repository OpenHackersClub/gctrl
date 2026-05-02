// LMStudioLlm — direct adapter against an OpenAI-compat local backend
// (LM Studio at 127.0.0.1:1234, Ollama at 11434, llama.cpp server, etc.).
//
// No API key required — local backends are typically wide open on loopback.
// All responses cost $0 (handled by costForResponse via isOpenAiCompatModel).
//
// Surface = full LlmServiceShape via makeLlmServiceShape.

import { Agent } from "undici"
import { Effect, Layer } from "effect"
import { LlmError } from "../errors.js"
import type { JsonResponseFormat } from "../lib/llm-prompts.js"
import { makeLlmServiceShape } from "../lib/llm-service-factory.js"
import {
  classifyHttpStatus,
  isConnRefused,
  llmErr,
  type NormalizedResponse,
  type OpenAiChatResponse,
  SERVICE_NAME,
  sessionIdFor,
  type ThinkingMode,
} from "../lib/llm-shared.js"
import { LlmService } from "../services/LlmService.js"

const llmFetchAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const DEFAULT_MODEL = "google/gemma-4-31b"
const DEFAULT_BASE_URL = "http://127.0.0.1:1234"

const apiBase = (): string =>
  (process.env.UBER_LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

const modelFor = (): string => process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL

const summaryModelFor = (): string =>
  process.env.UBER_LLM_SUMMARY_MODEL ?? process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL

const lmStudioDownErr = (path: string): LlmError =>
  llmErr(
    "unavailable",
    `${apiBase()}${path} unreachable — start LM Studio (or your OpenAI-compat backend) ` +
      `and load a model, then retry. Override base URL with UBER_LMSTUDIO_BASE_URL.`,
  )

const fetchLMStudio = (
  path: string,
  body: unknown,
): Effect.Effect<string, LlmError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${apiBase()}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-id": sessionIdFor(),
            "x-service-name": SERVICE_NAME,
          },
          body: JSON.stringify(body),
          dispatcher: llmFetchAgent,
          // biome-ignore lint/suspicious/noExplicitAny: undici-specific option
        } as any),
      catch: (e) => {
        if (isConnRefused(e)) return lmStudioDownErr(path)
        const cause = (e as { cause?: unknown })?.cause
        const causeStr = cause ? ` cause=${String(cause)}` : ""
        return llmErr(
          "unavailable",
          `lmstudio ${path} fetch failed: ${String(e)}${causeStr}`,
        )
      },
    })
    const raw = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        llmErr("unavailable", `lmstudio ${path} body read failed: ${String(e)}`),
    })
    if (!res.ok) {
      return yield* Effect.fail(
        llmErr(
          classifyHttpStatus(res.status),
          `lmstudio ${path} HTTP ${res.status}: ${raw.slice(0, 500)}`,
        ),
      )
    }
    return raw
  })

const lmStudioPostLlm = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  _thinking: ThinkingMode,
  _thinkingBudgetTokens: number,
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
    const raw = yield* fetchLMStudio("/v1/chat/completions", body)
    const parsed = yield* Effect.try({
      try: () =>
        raw.length > 0 ? (JSON.parse(raw) as OpenAiChatResponse) : ({} as OpenAiChatResponse),
      catch: (e) =>
        llmErr("invalid", `lmstudio /v1/chat/completions JSON.parse failed: ${String(e)}`),
    })
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      return yield* Effect.fail(
        llmErr("invalid", "lmstudio response missing choices[0].message.content string"),
      )
    }
    return {
      text: content,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      model: parsed.model ?? model,
    }
  })

export const LMStudioLlmLive = Layer.succeed(
  LlmService,
  makeLlmServiceShape({
    name: () => `lmstudio-direct@${modelFor()}`,
    postLlm: lmStudioPostLlm,
    modelFor,
    summaryModelFor,
  }),
)
