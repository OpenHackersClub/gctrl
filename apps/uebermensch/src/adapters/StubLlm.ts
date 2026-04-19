import { Effect, Layer } from "effect"
import { sha256 } from "../lib/hash.js"
import { LlmService } from "../services/LlmService.js"
import type { CuratedItem } from "../services/RendererService.js"

const STUB_MODEL = "stub-llm@0.1"

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
  ].join("\n")

export const StubLlmLive = Layer.succeed(LlmService, {
  name: () => STUB_MODEL,
  generateBrief: (req) =>
    Effect.sync(() => {
      const candidateIds = req.candidates.map((c) => c.id)
      const prompt = renderPrompt(req.date, req.profileName, req.topics, candidateIds)
      const promptHash = sha256(prompt)
      const topCandidates = [...req.candidates]
        .sort((a, b) => b.score - a.score)
        .slice(0, req.maxItems)
      const items: Array<CuratedItem> = topCandidates.map((c) => {
        const title =
          (c.page.frontmatter.title as string | undefined) ?? c.page.stem
        const pageTopics = (c.page.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []
        const topic = pageTopics[0] ?? null
        return {
          kind: "news",
          title,
          summary_md: `Stub summary for [[${c.page.stem}]].`,
          topic,
          thesis: null,
          source_candidate_ids: [c.id],
          suggested_action: null,
        }
      })
      if (items.length === 0) {
        items.push({
          kind: "news",
          title: "No activity",
          summary_md: "No candidate pages in window.",
          topic: null,
          thesis: null,
          source_candidate_ids: [],
          suggested_action: null,
        })
      }
      const topicsCovered = Array.from(
        new Set(items.map((i) => i.topic).filter((t): t is string => t !== null)),
      )
      return {
        items,
        topicsCovered,
        thesesCovered: [],
        promptHash,
        costUsd: 0,
        model: STUB_MODEL,
      }
    }),
})
