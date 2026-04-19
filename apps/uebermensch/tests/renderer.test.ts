import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { StrictRendererLive } from "../src/adapters/StrictRenderer.js"
import type { CandidateRef } from "../src/lib/candidates.js"
import {
  RendererService,
  type CuratedItem,
  type RenderInput,
} from "../src/services/RendererService.js"
import type { WikiPage } from "../src/services/VaultService.js"

const page = (stem: string): WikiPage => ({
  relPath: `wiki/sources/${stem}.md`,
  stem,
  frontmatter: { page_type: "source", slug: stem, topics: ["foo"] },
  body: "",
  mtime: new Date("2026-04-19T00:00:00Z"),
})

const cand = (id: string, stem: string): CandidateRef => ({ id, page: page(stem), score: 1 })

const baseInput = (
  items: ReadonlyArray<CuratedItem>,
  slugs: ReadonlyArray<string>,
  cands: ReadonlyArray<CandidateRef>,
): RenderInput => ({
  date: "2026-04-19",
  generator: "stub",
  model: "stub-llm",
  promptHash: "sha256:0".padEnd(71, "0"),
  costUsd: 0,
  profileName: "Test",
  topicsCovered: ["foo"],
  thesesCovered: [],
  candidates: cands,
  items,
  vaultSlugs: new Set(slugs),
})

const run = (input: RenderInput) =>
  Effect.gen(function* () {
    const r = yield* RendererService
    return yield* r.render(input)
  }).pipe(Effect.provide(StrictRendererLive))

describe("StrictRenderer", () => {
  it("renders markdown with H2 items and cited-claims count", async () => {
    const items: Array<CuratedItem> = [
      {
        kind: "news",
        title: "Alpha",
        summary_md: "Alpha update via [[alpha]]. Second sentence.",
        topic: "foo",
        thesis: null,
        source_candidate_ids: ["cand-0000"],
        suggested_action: null,
      },
    ]
    const result = await Effect.runPromise(
      run(baseInput(items, ["alpha"], [cand("cand-0000", "alpha")])),
    )
    expect(result.markdown).toContain("## 1. Alpha")
    expect(result.markdown).toContain("[[alpha]]")
    expect(result.markdown).toContain("prompt_hash:")
    expect(result.totalClaims).toBe(2)
    expect(result.citedClaims).toBe(1)
  })

  it("rejects typed-prefix wikilinks", async () => {
    const items: Array<CuratedItem> = [
      {
        kind: "news",
        title: "Bad",
        summary_md: "See [[thesis:alpha]] for details.",
        topic: null,
        thesis: null,
        source_candidate_ids: ["cand-0000"],
        suggested_action: null,
      },
    ]
    const exit = await Effect.runPromiseExit(
      run(baseInput(items, ["alpha"], [cand("cand-0000", "alpha")])),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause
      const msg = JSON.stringify(failure)
      expect(msg).toMatch(/typed_prefix/)
    }
  })

  it("rejects unresolved slugs", async () => {
    const items: Array<CuratedItem> = [
      {
        kind: "news",
        title: "Missing",
        summary_md: "Link to [[ghost]] which does not exist.",
        topic: null,
        thesis: null,
        source_candidate_ids: ["cand-0000"],
        suggested_action: null,
      },
    ]
    const exit = await Effect.runPromiseExit(
      run(baseInput(items, ["alpha"], [cand("cand-0000", "alpha")])),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const msg = JSON.stringify(exit.cause)
      expect(msg).toMatch(/unresolved/)
    }
  })

  it("rejects fabricated source candidate ids", async () => {
    const items: Array<CuratedItem> = [
      {
        kind: "news",
        title: "Fake source",
        summary_md: "Claim with [[alpha]].",
        topic: null,
        thesis: null,
        source_candidate_ids: ["cand-9999"],
        suggested_action: null,
      },
    ]
    const exit = await Effect.runPromiseExit(
      run(baseInput(items, ["alpha"], [cand("cand-0000", "alpha")])),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const msg = JSON.stringify(exit.cause)
      expect(msg).toMatch(/fabricated_source/)
    }
  })

  it("tolerates display-text wikilinks", async () => {
    const items: Array<CuratedItem> = [
      {
        kind: "news",
        title: "Pipe link",
        summary_md: "See [[alpha|the Alpha report]].",
        topic: null,
        thesis: null,
        source_candidate_ids: ["cand-0000"],
        suggested_action: null,
      },
    ]
    const result = await Effect.runPromise(
      run(baseInput(items, ["alpha"], [cand("cand-0000", "alpha")])),
    )
    expect(result.markdown).toContain("[[alpha|the Alpha report]]")
  })
})

