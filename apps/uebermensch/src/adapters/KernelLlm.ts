import { Effect, Layer, Schema } from "effect";
import { LlmError } from "../errors.js";
import type { CandidateRef } from "../lib/candidates.js";
import { sha256 } from "../lib/hash.js";
import {
  type BriefRequest,
  type InterestReportRequest,
  LlmService,
  type ResearchQueryRequest,
} from "../services/LlmService.js";
import type { CuratedItem } from "../services/RendererService.js";

const DEFAULT_MODEL = "claude-opus-4-7";
const ANTHROPIC_INPUT_COST_PER_MTOK = 5.0;
const ANTHROPIC_OUTPUT_COST_PER_MTOK = 25.0;
const MAX_CANDIDATE_EXCERPT = 2000;
const DEFAULT_MAX_TOKENS = 16000;

// Per-article summarization uses a cheaper model. Kernel /api/llm/messages
// routes through the AI Gateway so any model in the provider registry works.
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_INPUT_COST_PER_MTOK = 1.0;
const SUMMARY_OUTPUT_COST_PER_MTOK = 5.0;
const SUMMARY_MAX_TOKENS = 800;
const SUMMARY_INPUT_CHARS_CAP = 12000;

const modelFor = (): string => process.env.UBER_LLM_MODEL ?? DEFAULT_MODEL;

const isWorkersAiModel = (model: string): boolean => model.startsWith("@cf/");

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");

const excerptOf = (body: string, max: number): string => {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
};

const candidateBlock = (c: CandidateRef): string => {
  const fm = c.page.frontmatter;
  const title = (fm.title as string | undefined) ?? c.page.stem;
  const topics = ((fm.topics as ReadonlyArray<string> | undefined) ?? []).join(", ");
  const url = (fm.url as string | undefined) ?? "";
  const lines: Array<string> = [
    `- id: ${c.id}`,
    `  stem: ${c.page.stem}`,
    `  title: ${title}`,
    `  topics: [${topics}]`,
  ];
  if (url) lines.push(`  url: ${url}`);
  lines.push(`  score: ${c.score.toFixed(3)}`);
  lines.push(`  excerpt: |`);
  const excerptBody = excerptOf(c.page.body, MAX_CANDIDATE_EXCERPT);
  for (const line of excerptBody.split("\n")) lines.push(`    ${line}`);
  return lines.join("\n");
};

const SYSTEM_PROMPT = `You are uebermensch-curator, a chief-of-staff curator that produces a daily brief from a set of wiki pages.

OUTPUT CONTRACT:
- Output MUST be a single JSON object wrapped in a triple-backtick json fenced block. No prose outside the fence.
- Shape: { "items": CuratedItem[], "topicsCovered": string[], "thesesCovered": string[] }
- CuratedItem: {
    "kind": "news" | "update" | "action" | "alert",
    "title": string,
    "summary_md": string,
    "topic": string | null,
    "thesis": string | null,
    "source_candidate_ids": string[],
    "suggested_action": string | null
  }

CITATION RULES (strict — brief generation will FAIL if violated):
- Every \`[[link]]\` in \`summary_md\` MUST match a candidate's \`stem\` field exactly.
- Do NOT use typed-prefix links like \`[[source:x]]\` or \`[[thesis:x]]\` — bare stems only.
- \`source_candidate_ids\` MUST be a subset of the provided candidate \`id\` values (e.g. "cand-0000"). Never fabricate.

CURATION RULES:
- \`summary_md\` is 2–5 sentences of substantive, concrete content derived from the candidate excerpts. No hedging.
- Each item must cite at least one source via a \`[[stem]]\` link AND list the corresponding id in \`source_candidate_ids\`.
- Merge near-duplicate candidates into one item referencing multiple sources.
- \`topic\` is the single most relevant topic slug from the profile, or null.
- Produce at most \`maxItems\` items; prefer high-scored, topic-aligned candidates.
- If there are no usable candidates, return \`{ "items": [], "topicsCovered": [], "thesesCovered": [] }\`.`;

const buildUserPrompt = (req: BriefRequest): string => {
  const lines: Array<string> = [];
  lines.push(`date: ${req.date}`);
  lines.push(`profile: ${req.profileName}`);
  lines.push(`maxItems: ${req.maxItems}`);
  lines.push(`topics: [${req.topics.join(", ")}]`);
  lines.push(`theses: [${req.thesesSlugs.join(", ")}]`);
  lines.push("");
  lines.push("candidates:");
  for (const c of req.candidates) lines.push(candidateBlock(c));
  lines.push("");
  lines.push("Return ONLY a fenced ```json block with the schema above.");
  return lines.join("\n");
};

const ItemSchema = Schema.Struct({
  kind: Schema.Literal("news", "update", "action", "alert"),
  title: Schema.String,
  summary_md: Schema.String,
  topic: Schema.NullOr(Schema.String),
  thesis: Schema.NullOr(Schema.String),
  source_candidate_ids: Schema.Array(Schema.String),
  suggested_action: Schema.NullOr(Schema.String),
});

const LlmOutputSchema = Schema.Struct({
  items: Schema.Array(ItemSchema),
  topicsCovered: Schema.Array(Schema.String),
  thesesCovered: Schema.Array(Schema.String),
});

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

const extractJson = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
};

const llmErr = (kind: LlmError["kind"], message: string): LlmError =>
  new LlmError({ kind, message });

const classifyKernelStatus = (status: number): LlmError["kind"] => {
  if (status === 503) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 401 || status === 403) return "invalid";
  if (status >= 500) return "unavailable";
  return "invalid";
};

const tokensCost = (
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number => (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

const postAnthropic = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  thinking: boolean,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.tryPromise({
    try: async () => {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userPrompt }],
      };
      if (thinking) body.thinking = { type: "adaptive" };
      const res = await fetch(`${kernelBase()}/api/llm/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw llmErr(
          classifyKernelStatus(res.status),
          `kernel /api/llm/messages HTTP ${res.status}: ${raw.slice(0, 500)}`,
        );
      }
      const parsed = (raw.length > 0 ? JSON.parse(raw) : {}) as AnthropicResponse;
      const textBlock = (parsed.content ?? []).find(
        (b): b is { type: string; text: string } =>
          b.type === "text" && typeof b.text === "string",
      );
      if (!textBlock) {
        throw llmErr("invalid", "kernel response missing text content block");
      }
      return {
        text: textBlock.text,
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        model: parsed.model ?? model,
      };
    },
    catch: (e) =>
      e instanceof LlmError
        ? e
        : llmErr("unavailable", `kernel /api/llm/messages fetch failed: ${String(e)}`),
  });

const postWorkersAi = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
): Effect.Effect<NormalizedResponse, LlmError> =>
  Effect.tryPromise({
    try: async () => {
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
      };
      const res = await fetch(`${kernelBase()}/api/llm/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw llmErr(
          classifyKernelStatus(res.status),
          `kernel /api/llm/completions HTTP ${res.status}: ${raw.slice(0, 500)}`,
        );
      }
      const parsed = (raw.length > 0 ? JSON.parse(raw) : {}) as OpenAiChatResponse;
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw llmErr("invalid", "kernel response missing choices[0].message.content string");
      }
      return {
        text: content,
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        model: parsed.model ?? model,
      };
    },
    catch: (e) =>
      e instanceof LlmError
        ? e
        : llmErr("unavailable", `kernel /api/llm/completions fetch failed: ${String(e)}`),
  });

const postLlm = (
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
  thinking: boolean,
): Effect.Effect<NormalizedResponse, LlmError> =>
  isWorkersAiModel(model)
    ? postWorkersAi(model, system, userPrompt, maxTokens)
    : postAnthropic(model, system, userPrompt, maxTokens, thinking);

const REPORT_SYSTEM_PROMPT = `You are uebermensch-researcher, a chief-of-staff analyst. Your task is to produce a DEEP weekly research report for ONE research interest.

OUTPUT CONTRACT:
- Output MUST be a single JSON object wrapped in a triple-backtick json fenced block. No prose outside the fence.
- Shape: { "analysis_md": string, "items": CuratedItem[] }
- analysis_md: 600–1500 words of substantive long-form analysis, structured with level-3 markdown headers in this EXACT order:
    ### Thesis
    ### Key developments
    ### Cross-currents
    ### Implications
    ### Open questions
  - Thesis (1 short paragraph): the single most important claim of the week for this interest, stated sharply.
  - Key developments (2–5 paragraphs): concrete, specific developments grounded in the candidate excerpts. Tight bullets are acceptable here, but prefer prose that synthesizes across candidates.
  - Cross-currents (1–3 paragraphs): tensions, disagreements, or contradictions between sources; second-order effects; what is being priced in vs. not.
  - Implications (1–3 paragraphs): what this means for the interest's question. Concrete, falsifiable, decision-relevant.
  - Open questions (3–6 bullets): what would change the thesis, what to watch next, what evidence is missing.
- items (0 to maxItems): discrete curated news/updates/actions/alerts surfaced as evidence alongside the analysis.
- CuratedItem: {
    "kind": "news" | "update" | "action" | "alert",
    "title": string,
    "summary_md": string,   // 2–4 sentences, concrete
    "topic": string | null,
    "thesis": string | null,
    "source_candidate_ids": string[],
    "suggested_action": string | null
  }

CITATION RULES (strict — report generation will FAIL if violated):
- Every \`[[link]]\` in \`analysis_md\` or any item \`summary_md\` MUST match a candidate's \`stem\` field exactly.
- Do NOT use typed-prefix links like \`[[source:x]]\` or \`[[thesis:x]]\` — bare stems only.
- \`source_candidate_ids\` on each item MUST be a subset of the provided candidate \`id\` values. Never fabricate.
- Aim for ≥ 1 \`[[stem]]\` citation per paragraph in "Key developments" and at least 2 across "Cross-currents" + "Implications".

DEPTH RULES:
- Prefer concrete, falsifiable claims over hedged restatements of candidate excerpts.
- Synthesize across candidates: where do they agree, diverge, or contradict?
- Name actors, numbers, dates, and mechanisms. Avoid generic macro prose.
- Do NOT meta-describe the candidate pool ("the sources cover X", "based on these articles"). Write as a first-party analyst.

INSIGHT-ONLY RULES (strict — enforced by reviewer):
- Write substantive insight only. NEVER describe what is absent, thin, missing, or quiet in the candidate pool.
- BANNED phrases and patterns: "No direct X...", "No fresh X...", "appeared in the candidate set", "This week was quiet for...", "Candidate pool was thin...", "Most items were only indirectly relevant...", "Reference pages were also indexed but carry no new information", "Treat this week as a quiet one for...".
- If the candidate pool has no substantive signal at all (not even adjacent), return {"analysis_md": "", "items": []} — the caller will drop the empty report. Do NOT apologize or meta-commentate.
- If the candidate pool contains only adjacent signal (no direct hit on the interest's question), lead the Thesis with the adjacent signal as a concrete claim. Do NOT frame it as "No direct X but adjacent Y...".
- No "Suggested action" lines about expanding ingestion, adding feeds, or describing the system itself. Actions must target the substantive domain (markets, policy, company behavior).`;

const reportCandidateBlock = (c: CandidateRef): string => candidateBlock(c);

const buildInterestReportUserPrompt = (req: InterestReportRequest): string => {
  const it = req.interest;
  const lines: Array<string> = [];
  lines.push(`period: ${req.periodLabel}`);
  lines.push(`periodStart: ${req.periodStart}`);
  lines.push(`periodEnd: ${req.periodEnd}`);
  lines.push(`profile: ${req.profileName}`);
  lines.push(`maxItems: ${req.maxItems}`);
  lines.push("");
  lines.push("interest:");
  lines.push(`  slug: ${it.slug}`);
  lines.push(`  title: ${it.title}`);
  if (it.question) lines.push(`  question: ${it.question}`);
  lines.push(`  topics: [${it.topics.join(", ")}]`);
  if (it.notes) {
    lines.push(`  notes: |`);
    for (const line of it.notes.split("\n")) lines.push(`    ${line}`);
  }
  lines.push("");
  lines.push("candidates:");
  if (it.candidates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of it.candidates) lines.push(reportCandidateBlock(c));
  }
  lines.push("");
  lines.push("Return ONLY a fenced ```json block with the schema above.");
  return lines.join("\n");
};

const InterestReportOutputSchema = Schema.Struct({
  analysis_md: Schema.String,
  items: Schema.Array(ItemSchema),
});

const SUMMARY_SYSTEM_PROMPT = `You are uebermensch-ingest, an assistant that condenses a single news article into a compact set of key insights for a research wiki.

OUTPUT CONTRACT:
- Output ONLY markdown — no preamble, no JSON, no fenced blocks.
- Start with a heading "## Key Insights" on its own line.
- Follow with 3 to 6 bullet lines starting with "- ".
- Each bullet: one substantive fact or causal claim in 1–2 sentences, concrete, specific, lifted from the article.
- After the bullets, optionally add a heading "## Why it matters" with one or two bullet lines of implication for the reader's research topics.

STYLE RULES:
- Substantive insight only — no meta commentary about the article, no "the article discusses…", no hedging.
- Prefer numbers, named entities, dates, and policy specifics over generalities.
- Do NOT restate the title.
- Do NOT write UI/boilerplate like "read more", "share", photo credits, or bylines.
- Do NOT output anything outside the headings + bullets structure above.`;

const buildSummaryUserPrompt = (
  title: string,
  url: string,
  topics: ReadonlyArray<string>,
  text: string,
): string => {
  const lines: Array<string> = [];
  lines.push(`title: ${title}`);
  lines.push(`url: ${url}`);
  lines.push(`topics: [${topics.join(", ")}]`);
  lines.push("");
  lines.push("article:");
  lines.push(text);
  return lines.join("\n");
};

const RESEARCH_SYSTEM_PROMPT = `You are uebermensch-researcher, a chief-of-staff analyst answering a single user-authored research question by consolidating across the user's existing wiki context.

OUTPUT CONTRACT:
- Output ONLY markdown — no preamble, no JSON, no fenced wrapper.
- Begin with "## Question" on its own line followed by the question (one paragraph).
- Then "## Answer" with 200–800 words of substantive consolidated analysis.
- Then "## Key claims" with 3–7 concrete bullet claims, each ending with at least one bare \`[[stem]]\` citation when supported by a context page.
- Then "## Open questions" with 1–4 bullets the wiki cannot yet answer.

CITATION RULES (strict):
- Every \`[[link]]\` MUST match a provided context page \`stem\` exactly.
- Do NOT use typed-prefix links like \`[[source:x]]\`. Bare stems only.
- If no context pages were provided, omit \`[[stem]]\` citations entirely and state "(no wiki context yet)" in the Answer's first sentence.

STYLE:
- Substantive insight only — no meta commentary about the wiki, no "the context covers X".
- Concrete: name actors, numbers, dates, mechanisms.
- The body of the user's prompt may include hints, half-formed ideas, or links — treat them as signal but never echo them back verbatim as the answer.`;

const buildResearchQueryUserPrompt = (req: ResearchQueryRequest): string => {
  const lines: Array<string> = [];
  lines.push(`profile: ${req.profileName}`);
  lines.push(`slug: ${req.slug}`);
  lines.push(`title: ${req.title}`);
  lines.push(`topics: [${req.topics.join(", ")}]`);
  lines.push("");
  lines.push("question: |");
  for (const line of req.question.split("\n")) lines.push(`  ${line}`);
  lines.push("");
  lines.push("context_pages:");
  if (req.contextPages.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of req.contextPages) {
      lines.push(`- stem: ${p.stem}`);
      lines.push(`  title: ${p.title}`);
      lines.push(`  topics: [${p.topics.join(", ")}]`);
      lines.push(`  excerpt: |`);
      for (const line of p.excerpt.split("\n")) lines.push(`    ${line}`);
    }
  }
  lines.push("");
  lines.push("Return only the markdown body in the contract above.");
  return lines.join("\n");
};

// Clip any preamble before the "## Key Insights" heading; trim trailing
// whitespace. Models occasionally prefix with "Here are the key insights:" —
// drop everything up to the first heading.
const normalizeInsights = (raw: string): string => {
  const trimmed = raw.trim();
  const idx = trimmed.search(/^##\s+Key Insights/im);
  const body = idx >= 0 ? trimmed.slice(idx) : trimmed;
  return body.trim();
};

export const KernelLlmLive = Layer.succeed(LlmService, {
  name: () => `kernel-llm@${modelFor()}`,
  generateBrief: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildUserPrompt(req);
      const promptHash = sha256(`${SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const res = yield* postLlm(model, SYSTEM_PROMPT, userPrompt, DEFAULT_MAX_TOKENS, true);
      const raw = extractJson(res.text);
      if (raw === null) {
        return yield* Effect.fail(
          llmErr("invalid", "kernel response text did not contain a JSON object"),
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return yield* Effect.fail(
          llmErr("invalid", `kernel response JSON parse failed: ${String(e)}`),
        );
      }
      const decoded = yield* Schema.decodeUnknown(LlmOutputSchema)(parsed).pipe(
        Effect.mapError((e) => llmErr("invalid", `kernel response schema mismatch: ${String(e)}`)),
      );
      const costUsd = isWorkersAiModel(res.model)
        ? 0
        : tokensCost(
            res.inputTokens,
            res.outputTokens,
            ANTHROPIC_INPUT_COST_PER_MTOK,
            ANTHROPIC_OUTPUT_COST_PER_MTOK,
          );
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
  generateInterestReport: (req) =>
    Effect.gen(function* () {
      const model = modelFor();
      const userPrompt = buildInterestReportUserPrompt(req);
      const promptHash = sha256(`${REPORT_SYSTEM_PROMPT}\n---\n${userPrompt}`);
      const res = yield* postLlm(
        model,
        REPORT_SYSTEM_PROMPT,
        userPrompt,
        DEFAULT_MAX_TOKENS,
        true,
      );
      const raw = extractJson(res.text);
      if (raw === null) {
        return yield* Effect.fail(
          llmErr("invalid", "kernel response text did not contain a JSON object"),
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return yield* Effect.fail(
          llmErr("invalid", `kernel response JSON parse failed: ${String(e)}`),
        );
      }
      const decoded = yield* Schema.decodeUnknown(InterestReportOutputSchema)(parsed).pipe(
        Effect.mapError((e) => llmErr("invalid", `kernel response schema mismatch: ${String(e)}`)),
      );
      const costUsd = isWorkersAiModel(res.model)
        ? 0
        : tokensCost(
            res.inputTokens,
            res.outputTokens,
            ANTHROPIC_INPUT_COST_PER_MTOK,
            ANTHROPIC_OUTPUT_COST_PER_MTOK,
          );
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
      const res = yield* postLlm(
        model,
        RESEARCH_SYSTEM_PROMPT,
        userPrompt,
        DEFAULT_MAX_TOKENS,
        true,
      );
      const answerMd = res.text.trim();
      if (answerMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "kernel researchQuery returned empty body"));
      }
      const costUsd = isWorkersAiModel(res.model)
        ? 0
        : tokensCost(
            res.inputTokens,
            res.outputTokens,
            ANTHROPIC_INPUT_COST_PER_MTOK,
            ANTHROPIC_OUTPUT_COST_PER_MTOK,
          );
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
      const res = yield* postLlm(
        SUMMARY_MODEL,
        SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        SUMMARY_MAX_TOKENS,
        false,
      );
      const insightsMd = normalizeInsights(res.text);
      if (insightsMd.length === 0) {
        return yield* Effect.fail(llmErr("invalid", "kernel summarize returned empty insights"));
      }
      const costUsd = isWorkersAiModel(res.model)
        ? 0
        : tokensCost(
            res.inputTokens,
            res.outputTokens,
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

export const _internal = {
  buildUserPrompt,
  buildInterestReportUserPrompt,
  buildSummaryUserPrompt,
  buildResearchQueryUserPrompt,
  extractJson,
  kernelBase,
  LlmOutputSchema,
  InterestReportOutputSchema,
  normalizeInsights,
  SYSTEM_PROMPT,
  REPORT_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  MODEL: DEFAULT_MODEL,
  DEFAULT_MODEL,
  SUMMARY_MODEL,
  modelFor,
  isWorkersAiModel,
};
