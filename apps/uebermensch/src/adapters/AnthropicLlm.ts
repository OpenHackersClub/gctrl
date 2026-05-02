// AnthropicLlm — direct adapter against api.anthropic.com.
//
// Bypasses the gctrl kernel entirely so uebermensch in `--mode=local-direct`
// (and the future cloud-only Worker target) can run without a daemon.
// API key resolves via SecretsService at request time so rotation through
// the secrets backend takes effect on the next call.
//
// Surface = full LlmServiceShape via makeLlmServiceShape; only the transport
// (`anthropicPostLlm`) and Layer wiring live here.

import { Agent } from "undici"
import { Effect, Layer, Option } from "effect"
import { LlmError } from "../errors.js"
import type { JsonResponseFormat } from "../lib/llm-prompts.js"
import { makeLlmServiceShape } from "../lib/llm-service-factory.js"
import {
  type AnthropicResponse,
  classifyHttpStatus,
  isConnRefused,
  llmErr,
  type NormalizedResponse,
  SERVICE_NAME,
  sessionIdFor,
  type ThinkingMode,
  thinkingBody,
} from "../lib/llm-shared.js"
import { LlmService } from "../services/LlmService.js"
import { SecretsService } from "../services/SecretsService.js"

// Same long-running-completion rationale as KernelLlm — disable undici
// header/body timeouts so a 10-min Opus + extended-thinking call doesn't
// surface as `TypeError: fetch failed`.
const llmFetchAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const DEFAULT_MODEL = "claude-opus-4-7"
const DEFAULT_SUMMARY_MODEL = "claude-haiku-4-5"
const ANTHROPIC_VERSION = "2023-06-01"
const SECRET_KEY = "ANTHROPIC_API_KEY"

const apiBase = (): string =>
  (process.env.UBER_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "")

const modelFor = (): string => process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL

const summaryModelFor = (): string =>
  process.env.UBER_LLM_SUMMARY_MODEL ?? process.env.UBER_LLM_MODEL ?? DEFAULT_SUMMARY_MODEL

const missingKeyErr = (): LlmError =>
  llmErr(
    "invalid",
    `${SECRET_KEY} not provisioned — set the secret via your SecretsService backend ` +
      `(env: export ${SECRET_KEY}=sk-ant-…) or run uebermensch in --mode=local-kernel.`,
  )

const upstreamDownErr = (path: string): LlmError =>
  llmErr(
    "unavailable",
    `${apiBase()}${path} unreachable — check network connectivity ` +
      `(or override with UBER_ANTHROPIC_BASE_URL for tests).`,
  )

const fetchAnthropic = (
  path: string,
  body: unknown,
  apiKey: string,
): Effect.Effect<string, LlmError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${apiBase()}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            // Identity headers — preserved across kernel/direct so dashboards
            // group runs by session id consistently.
            "x-session-id": sessionIdFor(),
            "x-service-name": SERVICE_NAME,
          },
          body: JSON.stringify(body),
          dispatcher: llmFetchAgent,
          // biome-ignore lint/suspicious/noExplicitAny: undici-specific option
        } as any),
      catch: (e) => {
        if (isConnRefused(e)) return upstreamDownErr(path)
        const cause = (e as { cause?: unknown })?.cause
        const causeStr = cause ? ` cause=${String(cause)}` : ""
        return llmErr(
          "unavailable",
          `anthropic ${path} fetch failed: ${String(e)}${causeStr}`,
        )
      },
    })
    const raw = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        llmErr("unavailable", `anthropic ${path} body read failed: ${String(e)}`),
    })
    if (!res.ok) {
      return yield* Effect.fail(
        llmErr(
          classifyHttpStatus(res.status),
          `anthropic ${path} HTTP ${res.status}: ${raw.slice(0, 500)}`,
        ),
      )
    }
    return raw
  })

const makeAnthropicPostLlm =
  (
    getApiKey: () => Effect.Effect<string, LlmError>,
  ): ((
    model: string,
    system: string,
    userPrompt: string,
    maxTokens: number,
    thinking: ThinkingMode,
    thinkingBudgetTokens: number,
    jsonFormat: JsonResponseFormat | null,
  ) => Effect.Effect<NormalizedResponse, LlmError>) =>
  (model, system, userPrompt, maxTokens, thinking, thinkingBudgetTokens, _jsonFormat) =>
    Effect.gen(function* () {
      const apiKey = yield* getApiKey()
      // Anthropic's /v1/messages does not honor `response_format: json_schema`
      // in the same way OpenAI-compat backends do — the prompt itself enforces
      // JSON. Drop jsonFormat on this transport.
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userPrompt }],
        ...thinkingBody(thinking, thinkingBudgetTokens),
      }
      const raw = yield* fetchAnthropic("/v1/messages", body, apiKey)
      const parsed = yield* Effect.try({
        try: () =>
          raw.length > 0 ? (JSON.parse(raw) as AnthropicResponse) : ({} as AnthropicResponse),
        catch: (e) =>
          llmErr("invalid", `anthropic /v1/messages JSON.parse failed: ${String(e)}`),
      })
      const textBlock = (parsed.content ?? []).find(
        (b): b is { type: string; text: string } =>
          b.type === "text" && typeof b.text === "string",
      )
      if (!textBlock) {
        return yield* Effect.fail(
          llmErr("invalid", "anthropic response missing text content block"),
        )
      }
      return {
        text: textBlock.text,
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        model: parsed.model ?? model,
      }
    })

export const AnthropicLlmLive = Layer.effect(
  LlmService,
  Effect.gen(function* () {
    const secrets = yield* SecretsService
    const getApiKey = (): Effect.Effect<string, LlmError> =>
      secrets.get(SECRET_KEY).pipe(
        Effect.mapError((e) =>
          llmErr("unavailable", `secrets backend failure reading ${SECRET_KEY}: ${e.message}`),
        ),
        Effect.flatMap((opt) =>
          Option.match(opt, {
            onNone: () => Effect.fail(missingKeyErr()),
            onSome: (k) => Effect.succeed(k),
          }),
        ),
      )
    return makeLlmServiceShape({
      name: () => `anthropic-direct@${modelFor()}`,
      postLlm: makeAnthropicPostLlm(getApiKey),
      modelFor,
      summaryModelFor,
    })
  }),
)
