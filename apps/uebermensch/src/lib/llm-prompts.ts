// Prompt strings, prompt builders, output schemas, and response post-processing
// shared by every LlmPort adapter (KernelLlm today; AnthropicLlm, LMStudioLlm
// next). Transport, billing, model selection, and effort/thinking config stay
// in the adapter — this file is pure prompt + schema material so adapters
// cannot drift on prompt text without touching one place.

import { Effect, JSONSchema, Schema } from "effect";
import { LlmError } from "../errors.js";
import type { CandidateRef } from "./candidates.js";
import type {
  BriefRequest,
  InterestReportRequest,
  ResearchQueryRequest,
  SubtopicProposeRequest,
} from "../services/LlmService.js";

export const MAX_CANDIDATE_EXCERPT = 2000;
export const SUMMARY_INPUT_CHARS_CAP = 12000;
export const SUMMARY_MAX_TOKENS = 800;

// ---- Effect Schemas (output decoding) ----

const ItemSchema = Schema.Struct({
  kind: Schema.Literal("news", "update", "action", "alert"),
  title: Schema.String,
  summary_md: Schema.String,
  topic: Schema.NullOr(Schema.String),
  thesis: Schema.NullOr(Schema.String),
  source_candidate_ids: Schema.Array(Schema.String),
  suggested_action: Schema.NullOr(Schema.String),
});

export const LlmOutputSchema = Schema.Struct({
  items: Schema.Array(ItemSchema),
  topicsCovered: Schema.Array(Schema.String),
  thesesCovered: Schema.Array(Schema.String),
});

const SubtopicProposalSchema = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  rationale: Schema.String,
  relevant_candidate_ids: Schema.Array(Schema.String),
});

export const SubtopicProposeOutputSchema = Schema.Struct({
  proposals: Schema.Array(SubtopicProposalSchema).pipe(Schema.minItems(1)),
  selected_slug: Schema.String,
});

export const InterestReportOutputSchema = Schema.Struct({
  analysis_md: Schema.String,
  items: Schema.Array(ItemSchema),
});

// ---- Candidate-block YAML formatting (used by every prompt that takes candidates) ----

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
  // source_kind is set by the ingest pipeline (news / paper / research-blog /
  // primary). Surface it so the deep-dive prompt can promote primary research
  // citations into a "Latest research" frame for novice-mode interests.
  const sourceKind = (fm.source_kind as string | undefined) ?? "";
  const lines: Array<string> = [
    `- id: ${c.id}`,
    `  stem: ${c.page.stem}`,
    `  title: ${title}`,
    `  topics: [${topics}]`,
  ];
  if (sourceKind) lines.push(`  source_kind: ${sourceKind}`);
  if (url) lines.push(`  url: ${url}`);
  lines.push(`  score: ${c.score.toFixed(3)}`);
  lines.push(`  excerpt: |`);
  const excerptBody = excerptOf(c.page.body, MAX_CANDIDATE_EXCERPT);
  for (const line of excerptBody.split("\n")) lines.push(`    ${line}`);
  return lines.join("\n");
};

// ---- System prompts ----

export const SYSTEM_PROMPT = `You are uebermensch-curator, a chief-of-staff curator that produces a daily brief from a set of wiki pages.

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

export const SUBTOPIC_SYSTEM_PROMPT = `You are uebermensch-curator. Given a long-running research interest and the strongest candidates surfaced this week, identify 1–3 sharply focused SUB-TOPICS the deep-dive could explore this week, then pick the best one.

OUTPUT CONTRACT:
- Output MUST be a single JSON object wrapped in a triple-backtick json fenced block. No prose outside the fence.
- Shape:
  {
    "proposals": [
      {
        "slug": "kebab-case",                    // <= 60 chars, lower kebab
        "title": "Sub-topic title",              // <= 80 chars
        "rationale": "1–2 sentences",            // why this thread is the strongest signal
        "relevant_candidate_ids": ["..."]        // candidate ids that support this sub-topic
      }
    ],
    "selected_slug": "..."                       // MUST equal one proposals[].slug
  }

RULES:
- A sub-topic MUST be sharper than the interest's umbrella title — name a specific thread, actor, mechanism, ruling, paper, or development. NOT a paraphrase of the interest.
- 1–3 proposals. If signal is weak/diffuse, return ONE proposal capturing the dominant fragment rather than no proposals.
- relevant_candidate_ids MUST be a subset of the provided candidate ids — never fabricate.
- Rationale is concrete: name actors, numbers, dates, mechanisms. No meta phrases like "this week's pool covers...".
- selected_slug picks the proposal with the densest cited evidence and the highest decision-relevance for the interest's question.

INSIGHT-ONLY RULES (strict — apply to BOTH \`title\` and \`rationale\`):
- Title and rationale MUST assert something about the world. NEVER describe what is absent, thin, missing, sparse, or quiet in the candidate pool.
- BANNED phrases and patterns in title/rationale (non-exhaustive): "Absent X...", "Sparse week...", "No direct X...", "No fresh X...", "Only adjacent...", "Quiet week for...", "Pool was thin...", "No X catalyst...", "Reference pages were also indexed...", or any sentence whose subject is the candidate set / pipeline / inputs rather than the world.
- If the candidate pool has no substantive signal, pick the single sharpest concrete claim available (even if narrow) and frame the title around THAT claim — not around the absence of others.
- Title format: name a specific actor, ruling, paper, mechanism, or development. Examples of GOOD titles: "Tillis's Warsh-vote pivot and the 2026 NC Senate race", "BoJ IMES research workshop signals on policy framework". Examples of FORBIDDEN titles: "Absent MHLW/pharma signal; only BOJ-IMES surfaced", "Sparse week: no defense-specific catalyst".`;

export const REPORT_SYSTEM_PROMPT = `You are uebermensch-researcher, a chief-of-staff analyst. Your task is to produce a DEEP weekly research report for ONE research interest, focused on a chosen SUB-TOPIC for this week.

OUTPUT CONTRACT:
- Output MUST be a single JSON object wrapped in a triple-backtick json fenced block. No prose outside the fence.
- Shape: { "analysis_md": string, "items": CuratedItem[] }
- analysis_md: 600–1500 words of substantive long-form analysis, structured with level-3 markdown headers in this EXACT order:
    ### Thesis
    ### Key developments
    ### Cross-currents
    ### Implications
    ### Open questions
  - Thesis (1 short paragraph): the single most important claim of the week, framed around the FOCUS_SUBTOPIC if one is provided.
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

SUBTOPIC FOCUS RULES:
- If a FOCUS_SUBTOPIC block is provided, the entire report MUST be framed around that specific sub-thread. The interest's umbrella question is context only — DO NOT default to surveying the whole interest.
- Thesis MUST directly address the FOCUS_SUBTOPIC. Key developments / Cross-currents / Implications MUST stay on that thread; mention adjacent threads only when they bear on it.
- Open questions MUST be specific to the sub-topic, not the umbrella interest.

FIELD FAMILIARITY (controls tone, never citation rigor):
- "expert": assume technical fluency. Use domain jargon directly. Focus on second-order effects, mechanism nuance, and decision-relevant deltas. NO definitions of standard terms.
- "novice": ELI5 framing. Define every domain term on first use in one short clause (e.g. "BDCs (Business Development Companies — public-listed funds that lend to mid-market firms)"). Prefer concrete analogies and one short "Plain English:" callout per Key Development paragraph that restates the development for a non-specialist. Citation rigor and "no meta commentary" rules still apply.
- The FIELD_FAMILIARITY value will appear in the user prompt; honor it strictly.

STATE-OF-THE-ART RESEARCH:
- Each candidate may carry a \`source_kind\` field. Values: "news", "paper", "research-blog", "primary" (e.g. central-bank releases, SEC filings).
- If at least one cited candidate has source_kind in {"paper", "research-blog"}, INSERT a level-3 section "### Latest research" immediately after Thesis (so the order becomes: Thesis → Latest research → Key developments → Cross-currents → Implications → Open questions). The Latest research section is 1–2 paragraphs naming the paper/research piece(s), the authors/institution if shown, and the substantive finding — citations strict as elsewhere.
- For novice-mode interests, the Latest research section MUST translate the finding into one Plain English sentence at the end.
- If no candidate has a research source_kind, OMIT the section entirely — do not write "no research this week".

INSIGHT-ONLY RULES (strict — enforced by reviewer):
- Write substantive insight only. NEVER describe what is absent, thin, missing, or quiet in the candidate pool.
- BANNED phrases and patterns: "No direct X...", "No fresh X...", "appeared in the candidate set", "This week was quiet for...", "Candidate pool was thin...", "Most items were only indirectly relevant...", "Reference pages were also indexed but carry no new information", "Treat this week as a quiet one for...".
- If the candidate pool has no substantive signal at all (not even adjacent), return {"analysis_md": "", "items": []} — the caller will drop the empty report. Do NOT apologize or meta-commentate.
- If the candidate pool contains only adjacent signal (no direct hit on the interest's question), lead the Thesis with the adjacent signal as a concrete claim. Do NOT frame it as "No direct X but adjacent Y...".
- No "Suggested action" lines about expanding ingestion, adding feeds, or describing the system itself. Actions must target the substantive domain (markets, policy, company behavior).`;

export const SUMMARY_SYSTEM_PROMPT = `You are uebermensch-ingest, an assistant that condenses a single news article into a compact set of key insights for a research wiki.

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

export const RESEARCH_SYSTEM_PROMPT = `You are uebermensch-researcher, a chief-of-staff analyst answering a single user-authored research question by consolidating across the user's existing wiki context.

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

// ---- User-prompt builders ----

export const buildUserPrompt = (req: BriefRequest): string => {
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

export const buildSubtopicUserPrompt = (req: SubtopicProposeRequest): string => {
  const it = req.interest;
  const lines: Array<string> = [];
  lines.push(`period: ${req.periodLabel}`);
  lines.push(`periodStart: ${req.periodStart}`);
  lines.push(`periodEnd: ${req.periodEnd}`);
  lines.push(`profile: ${req.profileName}`);
  lines.push("");
  lines.push("interest:");
  lines.push(`  slug: ${it.slug}`);
  lines.push(`  title: ${it.title}`);
  if (it.question) lines.push(`  question: ${it.question}`);
  lines.push(`  topics: [${it.topics.join(", ")}]`);
  lines.push(`  field_familiarity: ${it.fieldFamiliarity}`);
  if (it.notes) {
    lines.push(`  notes: |`);
    for (const line of it.notes.split("\n")) lines.push(`    ${line}`);
  }
  lines.push("");
  lines.push("candidates:");
  if (it.candidates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of it.candidates) lines.push(candidateBlock(c));
  }
  lines.push("");
  lines.push("Return ONLY a fenced ```json block with the schema above.");
  return lines.join("\n");
};

export const buildInterestReportUserPrompt = (req: InterestReportRequest): string => {
  const it = req.interest;
  const lines: Array<string> = [];
  lines.push(`period: ${req.periodLabel}`);
  lines.push(`periodStart: ${req.periodStart}`);
  lines.push(`periodEnd: ${req.periodEnd}`);
  lines.push(`profile: ${req.profileName}`);
  lines.push(`maxItems: ${req.maxItems}`);
  lines.push(`field_familiarity: ${it.fieldFamiliarity}`);
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
  if (req.subtopic) {
    lines.push("FOCUS_SUBTOPIC:");
    lines.push(`  slug: ${req.subtopic.slug}`);
    lines.push(`  title: ${req.subtopic.title}`);
    lines.push(`  rationale: ${req.subtopic.rationale}`);
    lines.push("");
  }
  lines.push("candidates:");
  if (it.candidates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of it.candidates) lines.push(candidateBlock(c));
  }
  lines.push("");
  lines.push("Return ONLY a fenced ```json block with the schema above.");
  return lines.join("\n");
};

export const buildSummaryUserPrompt = (
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

export const buildResearchQueryUserPrompt = (req: ResearchQueryRequest): string => {
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

// ---- Response post-processing ----

export const extractJson = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
};

// Clip any preamble before the "## Key Insights" heading; trim trailing
// whitespace. Models occasionally prefix with "Here are the key insights:" —
// drop everything up to the first heading.
export const normalizeInsights = (raw: string): string => {
  const trimmed = raw.trim();
  const idx = trimmed.search(/^##\s+Key Insights/im);
  const body = idx >= 0 ? trimmed.slice(idx) : trimmed;
  return body.trim();
};

const llmErr = (kind: LlmError["kind"], message: string): LlmError =>
  new LlmError({ kind, message });

// Pull the first JSON object out of an LLM response and decode it against
// `schema`. All three failure modes (no JSON, JSON.parse error, schema
// mismatch) collapse to a single LlmError("invalid") with a contextual hint
// so callers don't reimplement the extract → parse → decode trio.
export const decodeLlmJson = <A, I>(
  text: string,
  schema: Schema.Schema<A, I>,
  contextLabel: string,
): Effect.Effect<A, LlmError> =>
  Effect.gen(function* () {
    const raw = extractJson(text);
    if (raw === null) {
      return yield* Effect.fail(
        llmErr("invalid", `${contextLabel}: response did not contain a JSON object`),
      );
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => llmErr("invalid", `${contextLabel}: JSON.parse failed: ${String(e)}`),
    });
    return yield* Schema.decodeUnknown(schema)(parsed).pipe(
      Effect.mapError((e) =>
        llmErr("invalid", `${contextLabel}: schema mismatch: ${String(e)}`),
      ),
    );
  });

// ---- JSON response_format hints (schema-derived; OpenAI-compat backends only) ----

export type JsonResponseFormat = {
  readonly name: string;
  readonly schema: unknown;
};

export const briefJsonFormat = (): JsonResponseFormat => ({
  name: "uber_brief",
  schema: JSONSchema.make(LlmOutputSchema),
});

export const subtopicJsonFormat = (): JsonResponseFormat => ({
  name: "uber_subtopic",
  schema: JSONSchema.make(SubtopicProposeOutputSchema),
});

export const interestReportJsonFormat = (): JsonResponseFormat => ({
  name: "uber_interest_report",
  schema: JSONSchema.make(InterestReportOutputSchema),
});
