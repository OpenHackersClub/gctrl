import { Effect, Layer } from "effect";
import { sha256 } from "../lib/hash.js";
import { LlmService } from "../services/LlmService.js";
import type { FreshnessProbe } from "../services/LlmService.js";
import type { CuratedItem, Reference } from "../services/RendererService.js";

const STUB_MODEL = "stub-llm@0.1";

// Build a minimal Citation Mode v1 reference entry for stub outputs.
const stubReference = (candidateId: string, n: number): Reference => ({
  n,
  source_page_id: candidateId,
  canonical_url: "https://example.com/" + candidateId,
  accessed_at: "2026-05-03T00:00:00Z",
  title: "stub",
  domain: "example.com",
});

const renderPrompt = (
  date: string,
  profileName: string,
  topics: ReadonlyArray<string>,
  candidateIds: ReadonlyArray<string>,
): string =>
  [
    "persona: uber-curator/stub",
    `date: ${date}`,
    `profile: ${profileName}`,
    `topics: ${topics.join(",")}`,
    `candidates: ${candidateIds.join(",")}`,
  ].join("\n");

export const StubLlmLive = Layer.succeed(LlmService, {
  name: () => STUB_MODEL,
  generateBrief: (req) =>
    Effect.sync(() => {
      const candidateIds = req.candidates.map((c) => c.id);
      const prompt = renderPrompt(req.date, req.profileName, req.topics, candidateIds);
      const promptHash = sha256(prompt);
      const topCandidates = [...req.candidates]
        .sort((a, b) => b.score - a.score)
        .slice(0, req.maxItems);
      const items: Array<CuratedItem> = topCandidates.map((c) => {
        const title = (c.page.frontmatter.title as string | undefined) ?? c.page.stem;
        const pageTopics = (c.page.frontmatter.topics as ReadonlyArray<string> | undefined) ?? [];
        const topic = pageTopics[0] ?? null;
        const references = [stubReference(c.id, 1)];
        return {
          kind: "news",
          title,
          summary_md: `Stub summary for [[${c.page.stem}]] [1].`,
          topic,
          thesis: null,
          references,
          source_candidate_ids: [c.id],
          suggested_action: null,
        };
      });
      const topicsCovered = Array.from(
        new Set(items.map((i) => i.topic).filter((t): t is string => t !== null)),
      );
      return {
        items,
        topicsCovered,
        thesesCovered: [],
        promptHash,
        costUsd: 0,
        model: STUB_MODEL,
      };
    }),
  summarizeSource: (req) =>
    Effect.sync(() => {
      const promptHash = sha256(`stub-summarize\n${req.url}\n${req.text}`);
      // Deterministic fixture digest — realistic cardinality for test assertions.
      const digest = {
        gist: [
          `${req.title} is the subject of this article.`,
          "Key policy changes were announced affecting multiple stakeholders.",
          "Market participants responded with notable shifts in positioning.",
        ],
        key_numbers: ["17 partner countries", "$42 billion total exposure"],
        essential_quotes: [
          {
            text: "This marks a historic shift in our approach.",
            attribution: "Official statement",
          },
        ],
        access: "open" as const,
      };
      return { digest, promptHash, costUsd: 0, model: STUB_MODEL };
    }),
  researchQuery: (req) =>
    Effect.sync(() => {
      const prompt = [
        "persona: uber-researcher/stub",
        `slug: ${req.slug}`,
        `profile: ${req.profileName}`,
        `topics: ${req.topics.join(",")}`,
        `context: ${req.contextPages.map((p) => p.stem).join(",")}`,
        `question: ${req.question}`,
      ].join("\n");
      const promptHash = sha256(prompt);
      const cited =
        req.contextPages.length > 0
          ? req.contextPages.map((p) => `[[${p.stem}]]`).join(", ")
          : "(no wiki context)";
      const answerMd = [
        `## Question`,
        ``,
        req.question.trim() || `(empty question for ${req.title})`,
        ``,
        `## Stub answer`,
        ``,
        `Stub research consolidation for "${req.title}" citing ${cited}.`,
      ].join("\n");
      return { answerMd, promptHash, costUsd: 0, model: STUB_MODEL };
    }),
  proposeSubtopic: (req) =>
    Effect.sync(() => {
      const it = req.interest;
      const prompt = [
        "persona: uber-curator/stub-subtopic",
        `period: ${req.periodLabel}`,
        `interest: ${it.slug}`,
        `candidates: ${it.candidates.map((c) => c.id).join(",")}`,
      ].join("\n");
      const promptHash = sha256(prompt);
      const top = [...it.candidates].sort((a, b) => b.score - a.score).slice(0, 5);
      // Deterministic stub: anchor sub-topic on the highest-scored candidate's
      // first page topic; fall back to the interest topic if candidates empty.
      const seed =
        (top[0]?.page.frontmatter.topics as ReadonlyArray<string> | undefined)?.[0] ??
        it.topics[0] ??
        it.slug;
      const proposalSlug = `${it.slug}--${seed}`.replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      const proposalTitle = `${it.title} — ${seed}`;
      const proposal = {
        slug: proposalSlug,
        title: proposalTitle,
        rationale: `Stub subtopic anchored on '${seed}' (top candidate signal).`,
        relevantCandidateIds: top.map((c) => c.id),
      };
      return {
        selectedSlug: proposalSlug,
        proposals: [proposal],
        promptHash,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: STUB_MODEL,
      };
    }),
  generateInterestReport: (req) =>
    Effect.sync(() => {
      const it = req.interest;
      const prompt = [
        "persona: uber-researcher/stub",
        `period: ${req.periodLabel}`,
        `profile: ${req.profileName}`,
        `interest: ${it.slug}`,
        `field_familiarity: ${it.fieldFamiliarity}`,
        `subtopic: ${req.subtopic?.slug ?? "(none)"}`,
        `candidates: ${it.candidates.map((c) => c.id).join(",")}`,
      ].join("\n");
      const promptHash = sha256(prompt);
      const top = [...it.candidates].sort((a, b) => b.score - a.score).slice(0, req.maxItems);
      const items: Array<CuratedItem> = top.map((c) => {
        const title = (c.page.frontmatter.title as string | undefined) ?? c.page.stem;
        const pageTopics = (c.page.frontmatter.topics as ReadonlyArray<string> | undefined) ?? [];
        const topic = pageTopics[0] ?? null;
        const references = [stubReference(c.id, 1)];
        return {
          kind: "news",
          title,
          summary_md: `Stub summary for [[${c.page.stem}]] [1].`,
          topic,
          thesis: null,
          references,
          source_candidate_ids: [c.id],
          suggested_action: null,
        };
      });
      const citedStems = top.map((c) => `[[${c.page.stem}]]`).join(", ");
      const analysis_md =
        top.length === 0
          ? ""
          : [
              "### Thesis",
              "",
              `Stub thesis for ${it.title}.`,
              "",
              "### Key developments",
              "",
              `Stub key developments citing ${citedStems}.`,
              "",
              "### Cross-currents",
              "",
              "Stub cross-currents.",
              "",
              "### Implications",
              "",
              "Stub implications.",
              "",
              "### Open questions",
              "",
              "- Stub open question 1",
              "- Stub open question 2",
            ].join("\n");
      return {
        interestSlug: it.slug,
        analysis_md,
        items,
        promptHash,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: STUB_MODEL,
      };
    }),
  generateProbes: (req) =>
    Effect.sync(() => {
      const prompt = [
        "persona: uber-freshness-probe/stub",
        `period: ${req.period.start}..${req.period.end}`,
        `entities: ${req.watchlistEntities.slice(0, 4).join(",")}`,
        `candidates: ${req.candidatesSummary.map((c) => c.slug).join(",")}`,
      ].join("\n");
      const promptHash = sha256(prompt);
      // Deterministic 2-probe fixture: one high-confidence, one medium.
      // Uses the first two watchlist entities if present; empty array if none.
      const entities = req.watchlistEntities.slice(0, 2);
      const probes: Array<FreshnessProbe> = entities.map((entity, i) => ({
        query: `${entity} release announcement ${req.period.end.slice(0, 4)}`,
        watchlist_entity: entity,
        rationale: `Stub probe for ${entity}: fixture deterministic output for tests.`,
        confidence: i === 0 ? ("high" as const) : ("medium" as const),
      }));
      return {
        probes,
        promptHash,
        costUsd: 0,
        model: STUB_MODEL,
      };
    }),
});
