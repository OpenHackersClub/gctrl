// Shared LLM types + cost math used by every LlmService adapter
// (KernelLlm via /api/llm, AnthropicLlm direct, LMStudioLlm direct).
// Lives separately from llm-prompts.ts because prompts are pure strings/
// schemas; this module owns the request/response shape + provider rates.

import { LlmError } from "../errors.js"
import type { JsonResponseFormat } from "./llm-prompts.js"
import type { Effect } from "effect"

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
export type OutputEffort = "low" | "medium" | "high"

// Anthropic `thinking` parameter shapes:
// - "off"      → no thinking field (model answers directly)
// - "adaptive" → `{ type: "adaptive" }` — model decides budget
// - "extended" → `{ type: "enabled", budget_tokens: N }` — explicit budget
export type ThinkingMode = "off" | "adaptive" | "extended"

export type EffortConfig = {
  readonly maxTokens: number
  readonly thinking: ThinkingMode
  readonly thinkingBudgetTokens: number
  // Opus 4.7 rejects `thinking.type: "enabled"` and instead controls effort
  // via top-level `output_config.effort`. When set, callers emit it in the
  // request body alongside `thinking: { type: "adaptive" }`.
  readonly outputEffort?: OutputEffort
}

const DEFAULT_MAX_TOKENS = 16000

// Anthropic's 1M context window is enabled per-request via the
// `anthropic-beta: context-1m-2025-08-07` header. Operators opt in by
// suffixing the model id (e.g. `claude-opus-4-7[1m]`) or by setting
// `UBER_LLM_CONTEXT_1M=1`. Any non-Anthropic model ignores the suffix.
export const CONTEXT_1M_BETA = "context-1m-2025-08-07"

export const stripContextSuffix = (model: string): string =>
  model.replace(/\[1m\]$/i, "")

export const is1MContextRequested = (model: string): boolean => {
  if (/\[1m\]$/i.test(model)) return true
  const env = process.env.UBER_LLM_CONTEXT_1M?.toLowerCase().trim()
  return env === "1" || env === "true" || env === "yes"
}

// Anthropic-shaped models go through /api/llm/messages. Everything else
// (`@cf/...` Workers AI, locally-served OpenAI-compat backends like
// LM Studio / Ollama) goes through /api/llm/completions.
export const isAnthropicModel = (model: string): boolean =>
  stripContextSuffix(model).startsWith("claude-")

// Back-compat alias for older imports.
export const isOpenAiCompatModel = (model: string): boolean => !isAnthropicModel(model)
export const isWorkersAiModel = isOpenAiCompatModel

// Models in the 4.7+ family use the new effort-control semantics:
// `thinking.type: "adaptive"` + `output_config.effort`. Older 4.x families
// (4.5/4.6) still accept `thinking.type: "enabled"` with a budget. Bump
// the regex when 4.8 lands.
export const isOpus47Family = (model: string): boolean =>
  /^claude-opus-4-(7|8|9)\b/.test(stripContextSuffix(model))

export const effortFromEnv = (): Effort => {
  const raw = process.env.UBER_LLM_EFFORT?.toLowerCase().trim()
  if (raw === "low" || raw === "high") return raw
  return "medium"
}

export const effortConfigFor = (effort: Effort, model?: string): EffortConfig => {
  if (model && isOpus47Family(model)) {
    switch (effort) {
      case "low":
        return {
          maxTokens: 4000,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "low",
        }
      case "high":
        return {
          maxTokens: 32000,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "high",
        }
      default:
        return {
          maxTokens: DEFAULT_MAX_TOKENS,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "medium",
        }
    }
  }
  switch (effort) {
    case "low":
      return { maxTokens: 4000, thinking: "off", thinkingBudgetTokens: 0 }
    case "high":
      return { maxTokens: 32000, thinking: "extended", thinkingBudgetTokens: 16000 }
    default:
      return { maxTokens: DEFAULT_MAX_TOKENS, thinking: "adaptive", thinkingBudgetTokens: 0 }
  }
}

export const effortBody = (cfg: EffortConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  if (cfg.thinking === "extended") {
    out.thinking = { type: "enabled", budget_tokens: cfg.thinkingBudgetTokens }
  } else if (cfg.thinking === "adaptive") {
    out.thinking = { type: "adaptive" }
  }
  // `output_config.effort` is opus-4.7+ only; older models 400 on it,
  // which is why we gate it through `EffortConfig.outputEffort` (set
  // exclusively by the opus-4.7 branch of `effortConfigFor`).
  if (cfg.outputEffort) {
    out.output_config = { effort: cfg.outputEffort }
  }
  return out
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
  if (isWorkersAiModel(res.model)) return 0
  if (inputRateOverride !== undefined && outputRateOverride !== undefined) {
    return tokensCost(res.inputTokens, res.outputTokens, inputRateOverride, outputRateOverride)
  }
  const [inputRate, outputRate] = ratesForModel(res.model)
  return tokensCost(res.inputTokens, res.outputTokens, inputRate, outputRate)
}

// ---------------------------------------------------------------------------
// Per-model concurrency defaults for the report pipeline. Anthropic
// rate-limits by tokens/minute per (org, model). Tier 1 opus-4.7 is the
// tightest at 30k input TPM — concurrency=1 + paced retries is the only
// way to make a clean run. Higher tiers can override with UBER_REPORT_CONCURRENCY.
// ---------------------------------------------------------------------------
export const defaultConcurrencyForModel = (model: string | undefined): number => {
  if (!model) return 2
  const m = stripContextSuffix(model)
  if (isOpus47Family(m)) return 1
  if (/^claude-opus-4-/.test(m)) return 2
  if (/^claude-sonnet-4-/.test(m)) return 4
  if (/^claude-haiku-4-/.test(m)) return 6
  return 2
}

// ---------------------------------------------------------------------------
// Parse `Retry-After` header (RFC 7231: delta-seconds OR HTTP-date).
// ---------------------------------------------------------------------------
export const parseRetryAfter = (raw: string | null | undefined): number | null => {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const asNum = Number.parseFloat(trimmed)
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(asNum, 120) * 1000
  }
  const t = Date.parse(trimmed)
  if (Number.isFinite(t)) {
    const delta = t - Date.now()
    return delta > 0 ? Math.min(delta, 120_000) : 0
  }
  return null
}

// ---------------------------------------------------------------------------
// Transport function type — every adapter implements this. Takes a fully
// resolved request (model + system + prompt + effort config + json format)
// and returns a normalized response. Errors typed as LlmError.
// ---------------------------------------------------------------------------
export type PostLlm = (
  model: string,
  system: string,
  userPrompt: string,
  cfg: EffortConfig,
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

export const llmErr = (
  kind: LlmError["kind"],
  message: string,
  retryAfterMs?: number,
): LlmError => new LlmError({ kind, message, retryAfterMs })

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
