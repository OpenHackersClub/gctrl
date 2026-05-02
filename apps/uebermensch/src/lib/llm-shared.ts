// Shared LLM types + cost math used by every LlmService adapter
// (KernelLlm via /api/llm, AnthropicLlm direct, LMStudioLlm direct).
// Lives separately from llm-prompts.ts because prompts are pure strings/
// schemas; this module owns the request/response shape + provider rates.

import { Effect } from "effect"
import { LlmError } from "../errors.js"
import type { JsonResponseFormat } from "./llm-prompts.js"

// ---------------------------------------------------------------------------
// Provider-agnostic response shape — every transport normalizes to this.
// ---------------------------------------------------------------------------
export type NormalizedResponse = {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly model: string
}

// Anthropic native messages response shape (used by both /api/llm/messages
// kernel proxy and direct api.anthropic.com).
export type AnthropicResponse = {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  readonly model?: string
}

// OpenAI-compat chat completions shape (used by both /api/llm/completions
// kernel proxy and direct LMStudio / Workers AI).
export type OpenAiChatResponse = {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
  readonly model?: string
}

// ---------------------------------------------------------------------------
// Effort tier + thinking config (operator-tunable via UBER_LLM_EFFORT)
// ---------------------------------------------------------------------------
export type Effort = "low" | "medium" | "high"

// Anthropic `thinking` parameter shapes:
// - "off"      → no thinking field (model answers directly)
// - "adaptive" → `{ type: "adaptive" }` — model decides budget
// - "extended" → `{ type: "enabled", budget_tokens: N }` — explicit budget
export type ThinkingMode = "off" | "adaptive" | "extended"

export type EffortConfig = {
  readonly maxTokens: number
  readonly thinking: ThinkingMode
  readonly thinkingBudgetTokens: number
}

const DEFAULT_MAX_TOKENS = 16000

export const effortFromEnv = (): Effort => {
  const raw = process.env.UBER_LLM_EFFORT?.toLowerCase().trim()
  if (raw === "low" || raw === "high") return raw
  return "medium"
}

export const effortConfigFor = (effort: Effort): EffortConfig => {
  switch (effort) {
    case "low":
      return { maxTokens: 4000, thinking: "off", thinkingBudgetTokens: 0 }
    case "high":
      return { maxTokens: 32000, thinking: "extended", thinkingBudgetTokens: 16000 }
    default:
      return { maxTokens: DEFAULT_MAX_TOKENS, thinking: "adaptive", thinkingBudgetTokens: 0 }
  }
}

export const thinkingBody = (
  thinking: ThinkingMode,
  budgetTokens: number,
): Record<string, unknown> => {
  if (thinking === "off") return {}
  if (thinking === "extended") {
    return { thinking: { type: "enabled", budget_tokens: budgetTokens } }
  }
  return { thinking: { type: "adaptive" } }
}

// ---------------------------------------------------------------------------
// Anthropic per-model USD/Mtok rates (input, output). Local + Workers AI
// models bill upstream (or are free), so they collapse to 0.
// ---------------------------------------------------------------------------
type CostRates = readonly [input: number, output: number]

const ANTHROPIC_RATES: ReadonlyArray<readonly [RegExp, CostRates]> = [
  [/^claude-opus-4-/, [15.0, 75.0]],
  [/^claude-sonnet-4-/, [3.0, 15.0]],
  [/^claude-haiku-4-/, [1.0, 5.0]],
  [/^claude-3-5-sonnet-/, [3.0, 15.0]],
  [/^claude-3-5-haiku-/, [1.0, 5.0]],
  [/^claude-3-opus-/, [15.0, 75.0]],
]

export const isAnthropicModel = (model: string): boolean => model.startsWith("claude-")
export const isOpenAiCompatModel = (model: string): boolean => !isAnthropicModel(model)
// Back-compat alias for older imports.
export const isWorkersAiModel = isOpenAiCompatModel

const ratesForModel = (model: string): CostRates => {
  if (!isAnthropicModel(model)) return [0, 0]
  for (const [pattern, rates] of ANTHROPIC_RATES) {
    if (pattern.test(model)) return rates
  }
  // Unknown claude-* — guess Sonnet rates so a new id surfaces in cost
  // telemetry instead of silently being free.
  return [3.0, 15.0]
}

export const tokensCost = (
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number => (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000

export const costForResponse = (
  res: NormalizedResponse,
  inputRateOverride?: number,
  outputRateOverride?: number,
): number => {
  if (isOpenAiCompatModel(res.model)) return 0
  if (inputRateOverride !== undefined && outputRateOverride !== undefined) {
    return tokensCost(res.inputTokens, res.outputTokens, inputRateOverride, outputRateOverride)
  }
  const [inputRate, outputRate] = ratesForModel(res.model)
  return tokensCost(res.inputTokens, res.outputTokens, inputRate, outputRate)
}

// ---------------------------------------------------------------------------
// Transport function type — every adapter implements this. Takes a fully
// resolved request (model + system + prompt + caps + json format) and
// returns a normalized response. Errors typed as LlmError.
// ---------------------------------------------------------------------------
export type PostLlm = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  thinking: ThinkingMode,
  thinkingBudgetTokens: number,
  jsonFormat: JsonResponseFormat | null,
) => Effect.Effect<NormalizedResponse, LlmError>

// ---------------------------------------------------------------------------
// Connection-level error walking (ECONNREFUSED → "kernel down" hint, etc.)
// ---------------------------------------------------------------------------
export const isConnRefused = (e: unknown): boolean => {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur != null; depth += 1) {
    const code = (cur as { code?: string }).code
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ECONNRESET"
    ) {
      return true
    }
    const errors = (cur as { errors?: ReadonlyArray<unknown> }).errors
    if (Array.isArray(errors) && errors.some(isConnRefused)) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

export const llmErr = (kind: LlmError["kind"], message: string): LlmError =>
  new LlmError({ kind, message })

export const classifyHttpStatus = (status: number): LlmError["kind"] => {
  if (status === 503) return "unavailable"
  if (status === 429) return "rate_limited"
  if (status === 400 || status === 401 || status === 403) return "invalid"
  if (status >= 500) return "unavailable"
  return "invalid"
}

// Identity for `x-session-id` / `x-service-name` headers consumed by
// driver-llm capture path. Kept here so every adapter sets the same
// headers (kernel-routed and direct alike).
export const SERVICE_NAME = "uebermensch"

let processSessionId: string | null = null
export const sessionIdFor = (): string => {
  const explicit = process.env.UBER_SESSION_ID
  if (explicit && explicit.length > 0) return explicit
  if (processSessionId === null) {
    processSessionId =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `uber-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  return processSessionId
}

// Test hook — clears the cached session id so a beforeEach can isolate runs.
export const _resetSessionIdForTests = (): void => {
  processSessionId = null
}
