import { Effect, Layer } from "effect"
import { LlmService } from "../services/LlmService.js"

export const StubLlmLive = Layer.succeed(LlmService, {
  name: () => "stub-llm@0.1",
  generateBrief: (req) =>
    Effect.sync(() => {
      const sorted = [...req.pages].sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      const picked = sorted.slice(0, 5)
      const items = picked.map((p, i) => {
        const title = (p.frontmatter.title as string | undefined) ?? p.stem
        return {
          heading: `${i + 1}. ${title}`,
          body: `Stub brief note on ${title} — based on [[${p.stem}]].`,
          citations: [p.stem],
        }
      })
      if (items.length === 0) {
        items.push({
          heading: "1. No recent activity",
          body: "Stub brief: no pages changed in window.",
          citations: [],
        })
      }
      const covered = new Set<string>()
      for (const p of picked) {
        const topics = p.frontmatter.topics as ReadonlyArray<string> | undefined
        if (topics) for (const t of topics) covered.add(t)
      }
      return { items, topicsCovered: [...covered] }
    }),
})
