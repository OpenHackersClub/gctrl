// makeLlmServiceShape — single implementation of the five LlmServiceShape
// methods (generateBrief, proposeSubtopic, generateInterestReport,
// researchQuery, summarizeSource) parameterized by a transport.
//
// Every adapter (KernelLlm, AnthropicLlm, LMStudioLlm) provides:
//   - `postLlm`: how to send a prompt + receive a NormalizedResponse
//   - `modelFor` / `summaryModelFor`: which model id to use per lane
//   - `name`: human-readable id (e.g. "anthropic-direct@claude-opus-4-7")
//
// All other behavior — prompt construction, JSON decoding, cost math,
// effort tier wiring — is shared, so adapters cannot drift on the
// per-method shape. The factory exists because the previous KernelLlmLive
// implementation reproduced the same five-method recipe inline (~200 LOC),
// and we now need three transports without three copies of the recipe.

import { Effect } from "effect"
import { sha256 } from "./hash.js"
import {
  briefJsonFormat,
  buildInterestReportUserPrompt,
  buildResearchQueryUserPrompt,
  buildSubtopicUserPrompt,
  buildSummaryUserPrompt,
  buildUserPrompt,
  decodeLlmJson,
  interestReportJsonFormat,
  InterestReportOutputSchema,
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
} from "./llm-prompts.js"
import {
  costForResponse,
  effortConfigFor,
  effortFromEnv,
  llmErr,
  type PostLlm,
} from "./llm-shared.js"
import type { CuratedItem } from "../services/RendererService.js"
import type { LlmServiceShape } from "../services/LlmService.js"

// Summary lane bills a fixed cheap rate when the underlying model is
// Anthropic-shaped (matches the historical KernelLlm hard-coding). For
// OpenAI-compat / local models, costForResponse already collapses to 0.
const SUMMARY_INPUT_COST_PER_MTOK = 1.0
const SUMMARY_OUTPUT_COST_PER_MTOK = 5.0

export type LlmServiceFactoryOpts = {
  /** Identity string surfaced in spans + logs (e.g. "anthropic-direct@<model>"). */
  readonly name: () => string
  /** Per-call transport — the only real provider seam. */
  readonly postLlm: PostLlm
  /** Model id to use for the curator lane (briefs, subtopics, reports, research). */
  readonly modelFor: () => string
  /** Model id to use for the summarization lane (per-source insights). */
  readonly summaryModelFor: () => string
}

export const makeLlmServiceShape = (opts: LlmServiceFactoryOpts): LlmServiceShape => ({
  name: opts.name,
  generateBrief: (req) =>
    Effect.gen(function* () {
      const model = opts.modelFor()
      const userPrompt = buildUserPrompt(req)
      const promptHash = sha256(`${SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const eff = effortConfigFor(effortFromEnv())
      const res = yield* opts.postLlm(
        model,
        SYSTEM_PROMPT,
        userPrompt,
        eff.maxTokens,
        eff.thinking,
        eff.thinkingBudgetTokens,
        briefJsonFormat(),
      )
      const decoded = yield* decodeLlmJson(res.text, LlmOutputSchema, "generateBrief")
      const items: ReadonlyArray<CuratedItem> = decoded.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        summary_md: i.summary_md,
        topic: i.topic,
        thesis: i.thesis,
        source_candidate_ids: i.source_candidate_ids,
        suggested_action: i.suggested_action,
      }))
      return {
        items,
        topicsCovered: decoded.topicsCovered,
        thesesCovered: decoded.thesesCovered,
        promptHash,
        costUsd: costForResponse(res),
        model: res.model,
      }
    }),
  proposeSubtopic: (req) =>
    Effect.gen(function* () {
      const model = opts.modelFor()
      const userPrompt = buildSubtopicUserPrompt(req)
      const promptHash = sha256(`${SUBTOPIC_SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const eff = effortConfigFor(effortFromEnv())
      const res = yield* opts.postLlm(
        model,
        SUBTOPIC_SYSTEM_PROMPT,
        userPrompt,
        eff.maxTokens,
        eff.thinking,
        eff.thinkingBudgetTokens,
        subtopicJsonFormat(),
      )
      const decoded = yield* decodeLlmJson(res.text, SubtopicProposeOutputSchema, "proposeSubtopic")
      const proposalSlugs = new Set(decoded.proposals.map((p) => p.slug))
      const selectedSlug = proposalSlugs.has(decoded.selected_slug)
        ? decoded.selected_slug
        : decoded.proposals[0].slug
      const candidateIds = new Set(req.interest.candidates.map((c) => c.id))
      const proposals = decoded.proposals.map((p) => ({
        slug: p.slug,
        title: p.title,
        rationale: p.rationale,
        relevantCandidateIds: p.relevant_candidate_ids.filter((id) => candidateIds.has(id)),
      }))
      return {
        selectedSlug,
        proposals,
        promptHash,
        costUsd: costForResponse(res),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model: res.model,
      }
    }),
  generateInterestReport: (req) =>
    Effect.gen(function* () {
      const model = opts.modelFor()
      const userPrompt = buildInterestReportUserPrompt(req)
      const promptHash = sha256(`${REPORT_SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const eff = effortConfigFor(effortFromEnv())
      const res = yield* opts.postLlm(
        model,
        REPORT_SYSTEM_PROMPT,
        userPrompt,
        eff.maxTokens,
        eff.thinking,
        eff.thinkingBudgetTokens,
        interestReportJsonFormat(),
      )
      const decoded = yield* decodeLlmJson(
        res.text,
        InterestReportOutputSchema,
        "generateInterestReport",
      )
      const items: ReadonlyArray<CuratedItem> = decoded.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        summary_md: i.summary_md,
        topic: i.topic,
        thesis: i.thesis,
        source_candidate_ids: i.source_candidate_ids,
        suggested_action: i.suggested_action,
      }))
      return {
        interestSlug: req.interest.slug,
        analysis_md: decoded.analysis_md,
        items,
        promptHash,
        costUsd: costForResponse(res),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model: res.model,
      }
    }),
  researchQuery: (req) =>
    Effect.gen(function* () {
      const model = opts.modelFor()
      const userPrompt = buildResearchQueryUserPrompt(req)
      const promptHash = sha256(`${RESEARCH_SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const eff = effortConfigFor(effortFromEnv())
      const res = yield* opts.postLlm(
        model,
        RESEARCH_SYSTEM_PROMPT,
        userPrompt,
        eff.maxTokens,
        eff.thinking,
        eff.thinkingBudgetTokens,
        null,
      )
      const answerMd = res.text.trim()
      if (answerMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "researchQuery returned empty body"))
      }
      return {
        answerMd,
        promptHash,
        costUsd: costForResponse(res),
        model: res.model,
      }
    }),
  summarizeSource: (req) =>
    Effect.gen(function* () {
      const capped =
        req.text.length > SUMMARY_INPUT_CHARS_CAP
          ? `${req.text.slice(0, SUMMARY_INPUT_CHARS_CAP)}…`
          : req.text
      const userPrompt = buildSummaryUserPrompt(req.title, req.url, req.topics, capped)
      const promptHash = sha256(`${SUMMARY_SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const res = yield* opts.postLlm(
        opts.summaryModelFor(),
        SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        SUMMARY_MAX_TOKENS,
        "off",
        0,
        null,
      )
      const insightsMd = normalizeInsights(res.text)
      if (insightsMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "summarize returned empty insights"))
      }
      return {
        insightsMd,
        promptHash,
        costUsd: costForResponse(
          res,
          SUMMARY_INPUT_COST_PER_MTOK,
          SUMMARY_OUTPUT_COST_PER_MTOK,
        ),
        model: res.model,
      }
    }),
})
