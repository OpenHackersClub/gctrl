import { Agent } from "undici";
import { Duration, Effect, Layer } from "effect";
import { LlmError } from "../errors.js";

// Constrained decoding under `response_format: json_schema` can run for many
// minutes on local backends (LMStudio + gemma) when the target schema has
// long markdown fields. Node's built-in fetch (undici) caps headers/body at
// 5 min; long single-shot completions hit that and surface as `TypeError:
// fetch failed`. Pass an undici Agent with timeouts disabled per request via
// the `dispatcher` option so the LLM stage isn't artificially capped — global
// fetch behavior is unchanged, so tests that mock `globalThis.fetch` and
// other consumers of fetch are unaffected.
const llmFetchAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
import { sha256 } from "../lib/hash.js";
import {
  briefJsonFormat,
  buildInterestReportUserPrompt,
  buildResearchQueryUserPrompt,
  buildSubtopicUserPrompt,
  buildSummaryUserPrompt,
  buildUserPrompt,
  decodeLlmJson,
  extractJson,
  interestReportJsonFormat,
  InterestReportOutputSchema,
  type JsonResponseFormat,
  LlmOutputSchema,
  normalizeInsights,
  REPORT_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  SUBTOPIC_SYSTEM_PROMPT,
  subtopicJsonFormat,
  SubtopicProposeOutputSchema,
  SUMMARY_INPUT_CHARS_CAP,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "../lib/llm-prompts.js";
import { LlmService } from "../services/LlmService.js";
import type { CuratedItem } from "../services/RendererService.js";

// Local-first default: kernel /api/llm/completions routes to LM Studio at
// 127.0.0.1:1234 unless GCTRL_LLM_PROVIDER=cloudflare is set on the kernel.
// Override with UBER_LLM_MODEL to match the model id loaded in your LM Studio
// instance (LM Studio typically echoes whatever model name it has loaded).
const DEFAULT_MODEL = "google/gemma-4-31b";
const DEFAULT_MAX_TOKENS = 16000;

// Per-model USD/Mtok rates (input, output). Workers AI / local backends bill
// kernel-side (or are free), so they collapse to 0 here. Anthropic rates
// matter because uebermensch persists per-report `cost_usd` in vault
// frontmatter — stale numbers there propagate into eval/dashboards.
type CostRates = readonly [input: number, output: number];

const ANTHROPIC_RATES: ReadonlyArray<readonly [RegExp, CostRates]> = [
  // Order matters: more specific patterns first.
  [/^claude-opus-4-/, [15.0, 75.0]],
  [/^claude-sonnet-4-/, [3.0, 15.0]],
  [/^claude-haiku-4-/, [1.0, 5.0]],
  // Older 3.x families (kept for back-compat — kernel may still relay).
  [/^claude-3-5-sonnet-/, [3.0, 15.0]],
  [/^claude-3-5-haiku-/, [1.0, 5.0]],
  [/^claude-3-opus-/, [15.0, 75.0]],
];

const ratesForModel = (model: string): CostRates => {
  if (!isAnthropicModel(model)) return [0, 0];
  for (const [pattern, rates] of ANTHROPIC_RATES) {
    if (pattern.test(model)) return rates;
  }
  // Unknown claude-* — fall back to Sonnet rates (mid-range guess) rather
  // than zero, so a new model id surfaces in cost telemetry instead of
  // silently being free.
  return [3.0, 15.0];
};

// Effort tier — operator-facing knob for how much LLM work to spend on a
// run. Maps to (max output tokens, thinking config). The lower-level
// per-provider billing concern (subscription vs metered, AI Gateway vs
// BYOK) lives in the kernel's driver-llm — uebermensch should not know
// or care.
type Effort = "low" | "medium" | "high";

const effortFromEnv = (): Effort => {
  const raw = process.env.UBER_LLM_EFFORT?.toLowerCase().trim();
  if (raw === "low" || raw === "high") return raw;
  return "medium";
};

// Anthropic `thinking` parameter shapes:
// - "off"      → no thinking field (model answers directly)
// - "adaptive" → `{ type: "adaptive" }` — model decides budget
// - "extended" → `{ type: "enabled", budget_tokens: N }` — explicit budget
type ThinkingMode = "off" | "adaptive" | "extended";

type OutputEffort = "low" | "medium" | "high";

type EffortConfig = {
  readonly maxTokens: number;
  readonly thinking: ThinkingMode;
  readonly thinkingBudgetTokens: number;
  // Opus 4.7 rejects `thinking.type: "enabled"` and instead controls effort
  // via top-level `output_config.effort`. When set, callers emit it in the
  // request body alongside `thinking: { type: "adaptive" }`.
  readonly outputEffort?: OutputEffort;
};

// Models in the 4.7+ family use the new effort-control semantics:
// `thinking.type: "adaptive"` + `output_config.effort`. Older 4.x families
// (4.5/4.6) still accept `thinking.type: "enabled"` with a budget. Bump
// the regex when 4.8 lands.
const isOpus47Family = (model: string): boolean =>
  /^claude-opus-4-(7|8|9)\b/.test(stripContextSuffix(model));

const effortConfigFor = (effort: Effort, model?: string): EffortConfig => {
  if (model && isOpus47Family(model)) {
    switch (effort) {
      case "low":
        return {
          maxTokens: 4000,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "low",
        };
      case "high":
        return {
          maxTokens: 32000,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "high",
        };
      default:
        return {
          maxTokens: DEFAULT_MAX_TOKENS,
          thinking: "adaptive",
          thinkingBudgetTokens: 0,
          outputEffort: "medium",
        };
    }
  }
  switch (effort) {
    case "low":
      // Tight cap, no thinking. Single-pass, fast, cheap.
      return { maxTokens: 4000, thinking: "off", thinkingBudgetTokens: 0 };
    case "high":
      // Generous output budget + explicit extended-thinking budget for
      // deeper synthesis. Doubles default max for long deep-dives.
      return { maxTokens: 32000, thinking: "extended", thinkingBudgetTokens: 16000 };
    default:
      // Adaptive thinking — model decides budget. Current default behavior.
      return { maxTokens: DEFAULT_MAX_TOKENS, thinking: "adaptive", thinkingBudgetTokens: 0 };
  }
};

// Per-article summarization shares the curator default by design — LM Studio
// typically has a single model loaded and echoes that name regardless of the
// `model` field. Override with UBER_LLM_SUMMARY_MODEL when running a separate
// smaller model on a second backend.
const DEFAULT_SUMMARY_MODEL = "google/gemma-4-31b";
const SUMMARY_INPUT_COST_PER_MTOK = 1.0;
const SUMMARY_OUTPUT_COST_PER_MTOK = 5.0;

const modelFor = (): string => process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL;

const summaryModelFor = (): string =>
  process.env.UBER_LLM_SUMMARY_MODEL ?? process.env.UBER_LLM_MODEL ?? DEFAULT_SUMMARY_MODEL;

// Anthropic-shaped models go through /api/llm/messages. Everything else
// (`@cf/...` Workers AI, locally-served OpenAI-compat backends like
// LM Studio / Ollama) goes through /api/llm/completions.
const isAnthropicModel = (model: string): boolean =>
  stripContextSuffix(model).startsWith("claude-");
// Back-compat alias — older callers/tests still import this name.
const isWorkersAiModel = (model: string): boolean => !isAnthropicModel(model);

// Anthropic's 1M context window is enabled per-request via the
// `anthropic-beta: context-1m-2025-08-07` header. Operators opt in by
// suffixing the model id (e.g. `claude-opus-4-7[1m]`) or by setting
// `UBER_LLM_CONTEXT_1M=1`. Any non-Anthropic model ignores the suffix.
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

const stripContextSuffix = (model: string): string =>
  model.replace(/\[1m\]$/i, "");

const is1MContextRequested = (model: string): boolean => {
  if (/\[1m\]$/i.test(model)) return true;
  const env = process.env.UBER_LLM_CONTEXT_1M?.toLowerCase().trim();
  return env === "1" || env === "true" || env === "yes";
};

// Per-model concurrency defaults for the report pipeline. Anthropic
// rate-limits by tokens/minute per (org, model). Tier 1 opus-4.7 is the
// tightest at 30k input TPM, so a single ~30k-token deep-dive prompt
// already saturates a minute — concurrency=1 + paced retries is the only
// way to make a clean run. Higher tiers can override with
// UBER_REPORT_CONCURRENCY.
const defaultConcurrencyForModel = (model: string | undefined): number => {
  if (!model) return 2;
  const m = stripContextSuffix(model);
  if (isOpus47Family(m)) return 1;
  if (/^claude-opus-4-/.test(m)) return 2;
  if (/^claude-sonnet-4-/.test(m)) return 4;
  if (/^claude-haiku-4-/.test(m)) return 6;
  return 2;
};

// Parse `Retry-After` header (RFC 7231: delta-seconds OR HTTP-date).
// Anthropic sends seconds; bare numbers are clamped to a sane ceiling so
// a buggy upstream can't stall a run for an hour. Returns ms or null.
const parseRetryAfter = (raw: string | null | undefined): number | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const asNum = Number.parseFloat(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(asNum, 120) * 1000;
  }
  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) {
    const delta = t - Date.now();
    return delta > 0 ? Math.min(delta, 120_000) : 0;
  }
  return null;
};

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");

// Identity headers consumed by the kernel's driver-llm capture path
// (vault/specs/implementation/llm-relay.md § "Convergence with driver-llm").
// Setting `x-session-id` makes the kernel persist a `prompt_bodies` row
// per turn and emit a generation span — uebermensch then shows up in
// /api/sessions and the analytics dashboard alongside opencode and the
// rest. `UBER_SESSION_ID` is the operator's hook for tying a logical run
// (e.g. one daily-brief invocation, one profile cycle) to a single
// session; the fallback is a process-lifetime UUID so a forgotten env
// var still produces *some* aggregated session rather than orphans.
const SERVICE_NAME = "uebermensch";
let processSessionId: string | null = null;
const sessionIdFor = (): string => {
  const explicit = process.env.UBER_SESSION_ID;
  if (explicit && explicit.length > 0) return explicit;
  if (processSessionId === null) {
    processSessionId =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `uber-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return processSessionId;
};

type AnthropicResponse = {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly model?: string;
};

type OpenAiChatResponse = {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly model?: string;
};

type NormalizedResponse = {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
};

const llmErr = (
  kind: LlmError["kind"],
  message: string,
  retryAfterMs?: number,
): LlmError => new LlmError({ kind, message, retryAfterMs });

const classifyKernelStatus = (status: number): LlmError["kind"] => {
  if (status === 503) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 401 || status === 403) return "invalid";
  if (status >= 500) return "unavailable";
  return "invalid";
};

// Node's fetch surfaces a connection refusal as `TypeError: fetch failed`
// with a nested `cause` carrying `code: ECONNREFUSED`. Walk the chain so we
// can tell the user the kernel daemon is simply down vs. some other failure.
const isConnRefused = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur != null; depth += 1) {
    const code = (cur as { code?: string }).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ECONNRESET"
    ) {
      return true;
    }
    const errors = (cur as { errors?: ReadonlyArray<unknown> }).errors;
    if (Array.isArray(errors) && errors.some(isConnRefused)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

const kernelDownErr = (path: string): LlmError =>
  llmErr(
    "unavailable",
    `kernel daemon not reachable at ${kernelBase()}${path} — start it with: ` +
      `gctrld serve --port 4318 (or set GCTRL_KERNEL_URL to point at a running kernel)`,
  );

const tokensCost = (
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number => (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

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
        if (isConnRefused(e)) return kernelDownErr(path);
        const cause = (e as { cause?: unknown })?.cause;
        const causeStr = cause ? ` cause=${String(cause)}` : "";
        return llmErr("unavailable", `kernel ${path} fetch failed: ${String(e)}${causeStr}`);
      },
    });
    const raw = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        llmErr("unavailable", `kernel ${path} body read failed: ${String(e)}`),
    });
    if (!res.ok) {
      const kind = classifyKernelStatus(res.status);
      let retryAfterMs: number | undefined;
      if (kind === "rate_limited") {
        // Headers may be unavailable on test mocks — guard the lookup.
        const headerGet = (k: string): string | null => {
          try {
            return res.headers?.get?.(k) ?? null;
          } catch {
            return null;
          }
        };
        const ra =
          parseRetryAfter(headerGet("retry-after")) ??
          // Anthropic also sends `anthropic-ratelimit-input-tokens-reset`
          // as an ISO-8601 timestamp. Honor it as a fallback so paced
          // retries don't hammer the upstream early.
          parseRetryAfter(headerGet("anthropic-ratelimit-input-tokens-reset")) ??
          parseRetryAfter(headerGet("anthropic-ratelimit-tokens-reset"));
        if (ra !== null) retryAfterMs = ra;
      }
      return yield* Effect.fail(
        llmErr(
          kind,
          `kernel ${path} HTTP ${res.status}: ${raw.slice(0, 500)}`,
          retryAfterMs,
        ),
      );
    }
    return raw;
  });

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
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

type RateLimitConfig = {
  readonly maxRetries: number;
  readonly baseMs: number;
  readonly maxMs: number;
};

const rateLimitConfig = (): RateLimitConfig => ({
  maxRetries: envInt("UBER_LLM_RATE_LIMIT_RETRIES", 4),
  baseMs: envInt("UBER_LLM_RATE_LIMIT_BASE_MS", 2_000, 1),
  maxMs: envInt("UBER_LLM_RATE_LIMIT_MAX_MS", 60_000, 1),
});

const isTransientKind = (kind: LlmError["kind"]): boolean =>
  kind === "rate_limited" || kind === "unavailable";

const withRateLimitRetry = <A>(
  eff: Effect.Effect<A, LlmError>,
): Effect.Effect<A, LlmError> => {
  const cfg = rateLimitConfig();
  const loop = (attempt: number): Effect.Effect<A, LlmError> =>
    eff.pipe(
      Effect.catchTag("LlmError", (e) => {
        if (!isTransientKind(e.kind) || attempt >= cfg.maxRetries) {
          return Effect.fail(e);
        }
        const expBackoff = Math.min(cfg.baseMs * 2 ** attempt, cfg.maxMs);
        // 429 supplies retryAfterMs; 5xx does not — fall back to
        // exponential. Cap the hint at MAX_MS too so a buggy upstream
        // can't stall a run.
        const hint = e.retryAfterMs;
        const delayMs =
          hint !== undefined ? Math.min(hint, cfg.maxMs) : expBackoff;
        return Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(loop(attempt + 1)),
        );
      }),
    );
  return loop(0);
};

const effortBody = (cfg: EffortConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (cfg.thinking === "extended") {
    out.thinking = { type: "enabled", budget_tokens: cfg.thinkingBudgetTokens };
  } else if (cfg.thinking === "adaptive") {
    out.thinking = { type: "adaptive" };
  }
  // `output_config.effort` is opus-4.7+ only; older models 400 on it,
  // which is why we gate it through `EffortConfig.outputEffort` (set
  // exclusively by the opus-4.7 branch of `effortConfigFor`).
  if (cfg.outputEffort) {
    out.output_config = { effort: cfg.outputEffort };
  }
  return out;
};

const postAnthropic = (
  model: string,
  system: string,
  userPrompt: string,
  cfg: EffortConfig,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.gen(function* () {
    const wireModel = stripContextSuffix(model);
    const body: Record<string, unknown> = {
      model: wireModel,
      max_tokens: cfg.maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
      ...effortBody(cfg),
    };
    const headers: Record<string, string> = {};
    if (is1MContextRequested(model)) headers["anthropic-beta"] = CONTEXT_1M_BETA;
    const raw = yield* fetchKernel("/api/llm/messages", body, headers);
    const parsed = yield* Effect.try({
      try: () =>
        (raw.length > 0 ? (JSON.parse(raw) as AnthropicResponse) : ({} as AnthropicResponse)),
      catch: (e) =>
        llmErr("invalid", `kernel /api/llm/messages JSON.parse failed: ${String(e)}`),
    });
    const textBlock = (parsed.content ?? []).find(
      (b): b is { type: string; text: string } =>
        b.type === "text" && typeof b.text === "string",
    );
    if (!textBlock) {
      return yield* Effect.fail(
        llmErr("invalid", "kernel response missing text content block"),
      );
    }
    return {
      text: textBlock.text,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      model: parsed.model ?? wireModel,
    };
  });

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
    };
    const raw = yield* fetchKernel("/api/llm/completions", body);
    const parsed = yield* Effect.try({
      try: () =>
        (raw.length > 0 ? (JSON.parse(raw) as OpenAiChatResponse) : ({} as OpenAiChatResponse)),
      catch: (e) =>
        llmErr("invalid", `kernel /api/llm/completions JSON.parse failed: ${String(e)}`),
    });
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return yield* Effect.fail(
        llmErr("invalid", "kernel response missing choices[0].message.content string"),
      );
    }
    return {
      text: content,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      model: parsed.model ?? model,
    };
  });

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
  );

// USD cost for a normalized LLM response. Workers AI / local models
// always cost $0. Anthropic models look up rates by model id so Opus 4.7
// ($15/$75) and Sonnet 4.6 ($3/$15) bill correctly without a redeploy.
// Optional rate overrides keep the summary lane (which used custom rates)
// working unchanged.
const costForResponse = (
  res: NormalizedResponse,
  inputRateOverride?: number,
  outputRateOverride?: number,
): number => {
  if (isWorkersAiModel(res.model)) return 0;
  if (inputRateOverride !== undefined && outputRateOverride !== undefined) {
    return tokensCost(res.inputTokens, res.outputTokens, inputRateOverride, outputRateOverride);
  }
  const [inputRate, outputRate] = ratesForModel(res.model);
  return tokensCost(res.inputTokens, res.outputTokens, inputRate, outputRate);
};

export const KernelLlmLive = Layer.succeed(LlmService, {
  name: () => `kernel-llm@${modelFor()}`,
  generateBrief: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildUserPrompt(req);
      const promptHash = sha256(`${SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const eff = effortConfigFor(effortFromEnv(), model);
      const res = yield* postLlm(
        model,
        SYSTEM_PROMPT,
        userPrompt,
        eff,
        briefJsonFormat(),
      );
      const decoded = yield* decodeLlmJson(res.text, LlmOutputSchema, "kernel /api/llm/messages");
      const costUsd = costForResponse(res);
      const items: ReadonlyArray<CuratedItem> = decoded.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        summary_md: i.summary_md,
        topic: i.topic,
        thesis: i.thesis,
        source_candidate_ids: i.source_candidate_ids,
        suggested_action: i.suggested_action,
      }));
      return {
        items,
        topicsCovered: decoded.topicsCovered,
        thesesCovered: decoded.thesesCovered,
        promptHash,
        costUsd,
        model: res.model,
      };
    }),
  proposeSubtopic: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildSubtopicUserPrompt(req);
      const promptHash = sha256(`${SUBTOPIC_SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const eff = effortConfigFor(effortFromEnv(), model);
      const res = yield* postLlm(
        model,
        SUBTOPIC_SYSTEM_PROMPT,
        userPrompt,
        eff,
        subtopicJsonFormat(),
      );
      const decoded = yield* decodeLlmJson(
        res.text,
        SubtopicProposeOutputSchema,
        "kernel subtopic",
      );
      const proposalSlugs = new Set(decoded.proposals.map((p) => p.slug));
      const selectedSlug = proposalSlugs.has(decoded.selected_slug)
        ? decoded.selected_slug
        : decoded.proposals[0].slug;
      const candidateIds = new Set(req.interest.candidates.map((c) => c.id));
      const proposals = decoded.proposals.map((p) => ({
        slug: p.slug,
        title: p.title,
        rationale: p.rationale,
        relevantCandidateIds: p.relevant_candidate_ids.filter((id) => candidateIds.has(id)),
      }));
      const costUsd = costForResponse(res);
      return {
        selectedSlug,
        proposals,
        promptHash,
        costUsd,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model: res.model,
      };
    }),
  generateInterestReport: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildInterestReportUserPrompt(req);
      const promptHash = sha256(`${REPORT_SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const eff = effortConfigFor(effortFromEnv(), model);
      const res = yield* postLlm(
        model,
        REPORT_SYSTEM_PROMPT,
        userPrompt,
        eff,
        interestReportJsonFormat(),
      );
      const decoded = yield* decodeLlmJson(
        res.text,
        InterestReportOutputSchema,
        "kernel interest report",
      );
      const costUsd = costForResponse(res);
      const items: ReadonlyArray<CuratedItem> = decoded.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        summary_md: i.summary_md,
        topic: i.topic,
        thesis: i.thesis,
        source_candidate_ids: i.source_candidate_ids,
        suggested_action: i.suggested_action,
      }));
      return {
        interestSlug: req.interest.slug,
        analysis_md: decoded.analysis_md,
        items,
        promptHash,
        costUsd,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model: res.model,
      };
    }),
  researchQuery: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildResearchQueryUserPrompt(req);
      const promptHash = sha256(`${RESEARCH_SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const eff = effortConfigFor(effortFromEnv(), model);
      const res = yield* postLlm(
        model,
        RESEARCH_SYSTEM_PROMPT,
        userPrompt,
        eff,
        null,
      );
      const answerMd = res.text.trim();
      if (answerMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "kernel researchQuery returned empty body"));
      }
      const costUsd = costForResponse(res);
      return { answerMd, promptHash, costUsd, model: res.model };
    }),
  summarizeSource: (req) =>
    Effect.gen(function* () {
      const capped =
        req.text.length > SUMMARY_INPUT_CHARS_CAP
          ? `${req.text.slice(0, SUMMARY_INPUT_CHARS_CAP)}…`
          : req.text;
      const userPrompt = buildSummaryUserPrompt(req.title, req.url, req.topics, capped);
      const promptHash = sha256(`${SUMMARY_SYSTEM_PROMPT}\n---\n${userPrompt}`);
      // Summary lane is always low-effort: short, cheap, no thinking. Not
      // operator-tunable — bumping summarization to "high" would 10x the
      // ingest spend with negligible quality lift.
      const summaryCfg: EffortConfig = {
        maxTokens: SUMMARY_MAX_TOKENS,
        thinking: "off",
        thinkingBudgetTokens: 0,
      };
      const res = yield* postLlm(
        summaryModelFor(),
        SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        summaryCfg,
        null,
      );
      const insightsMd = normalizeInsights(res.text);
      if (insightsMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "kernel summarize returned empty insights"));
      }
      const costUsd = costForResponse(
        res,
        SUMMARY_INPUT_COST_PER_MTOK,
        SUMMARY_OUTPUT_COST_PER_MTOK,
      );
      return {
        insightsMd,
        promptHash,
        costUsd,
        model: res.model,
      };
    }),
});

// Re-export prompt/schema material for tests that historically reach into
// `_internal`. Tests should migrate to importing directly from
// `lib/llm-prompts.ts`, but keeping the shape stable here avoids touching
// every test in this PR — they get rewritten in the AnthropicLlm follow-up.
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
};
