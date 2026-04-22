import { Effect, Layer } from "effect";
import { sha256 } from "../lib/hash.js";
import { LlmService, type ReportSection } from "../services/LlmService.js";
import type { CuratedItem } from "../services/RendererService.js";

const STUB_MODEL = "stub-llm@0.1";

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
        return {
          kind: "news",
          title,
          summary_md: `Stub summary for [[${c.page.stem}]].`,
          topic,
          thesis: null,
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
      const sentences = req.text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 3);
      const bullets =
        sentences.length > 0 ? sentences.map((s) => `- ${s}`).join("\n") : "- (no content)";
      const insightsMd = `## Key Insights\n\n${bullets}\n`;
      const promptHash = sha256(`stub-summarize\n${req.url}\n${req.text}`);
      return { insightsMd, promptHash, costUsd: 0, model: STUB_MODEL };
    }),
  generateReport: (req) =>
    Effect.sync(() => {
      const candidateIds = req.interests.flatMap((it) => it.candidates.map((c) => c.id));
      const prompt = [
        "persona: uber-researcher/stub",
        `period: ${req.periodLabel}`,
        `profile: ${req.profileName}`,
        `interests: ${req.interests.map((i) => i.slug).join(",")}`,
        `candidates: ${candidateIds.join(",")}`,
      ].join("\n");
      const promptHash = sha256(prompt);
      const sections: Array<ReportSection> = req.interests.map((it) => {
        const top = [...it.candidates]
          .sort((a, b) => b.score - a.score)
          .slice(0, req.maxItemsPerInterest);
        const items: Array<CuratedItem> = top.map((c) => {
          const title = (c.page.frontmatter.title as string | undefined) ?? c.page.stem;
          const pageTopics = (c.page.frontmatter.topics as ReadonlyArray<string> | undefined) ?? [];
          const topic = pageTopics[0] ?? null;
          return {
            kind: "news",
            title,
            summary_md: `Stub summary for [[${c.page.stem}]].`,
            topic,
            thesis: null,
            source_candidate_ids: [c.id],
            suggested_action: null,
          };
        });
        const summary_md =
          items.length === 0
            ? `No new candidates this week for ${it.title}.`
            : `Stub weekly overview for ${it.title} covering ${items.length} item(s).`;
        return { interestSlug: it.slug, summary_md, items };
      });
      return {
        sections,
        promptHash,
        costUsd: 0,
        model: STUB_MODEL,
      };
    }),
});
