import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { StrictRendererLive } from "../src/adapters/StrictRenderer.js"
import type { CandidateRef } from "../src/lib/candidates.js"
import {
  RendererService,
  type CuratedItem,
  type InterestReportRenderInput,
  type RenderInput,
} from "../src/services/RendererService.js"
import type { WikiPage } from "../src/services/VaultService.js"

const page = (stem: string): WikiPage => ({
  relPath: `input/raw/${stem}.md`,
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

describe("StrictRenderer.renderInterestReport — subtopic + field_familiarity", () => {
  const runReport = (input: InterestReportRenderInput) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* RendererService
        return yield* r.renderInterestReport(input)
      }).pipe(Effect.provide(StrictRendererLive)),
    )

  const cands = [cand("cand-0000", "alpha-source")]

  it("frontmatter and title surface the selected subtopic", async () => {
    const result = await runReport({
      periodLabel: "2026-W18",
      periodStart: "2026-04-21",
      periodEnd: "2026-04-28",
      generator: "stub",
      model: "stub-llm",
      promptHash: "sha256:" + "0".repeat(64),
      costUsd: 0,
      profileName: "Test",
      interestSlug: "japan-macro",
      interestTitle: "Japan macroeconomics",
      interestQuestion: "What's moving BoJ policy?",
      interestTopics: ["japan-macro"],
      fieldFamiliarity: "expert",
      subtopic: {
        slug: "japan-macro--boj-private-credit",
        title: "BoJ flags private-credit linkages",
        rationale: "BoJ research review highlights JP banks' BDC exposure.",
      },
      subtopicAlternatives: [
        {
          slug: "japan-macro--takaichi-arms-exports",
          title: "Takaichi loosens arms-export rules",
          rationale: "Policy shift opens defense revenue.",
        },
      ],
      analysis_md:
        "### Thesis\n\nBoJ supervisory shift on private credit [[alpha-source]].\n\n### Key developments\n\nDetails [[alpha-source]].\n\n### Cross-currents\n\nNone notable.\n\n### Implications\n\nBank capital buffers [[alpha-source]].\n\n### Open questions\n\n- Will rules tighten?",
      items: [],
      candidates: cands,
      vaultSlugs: new Set(["alpha-source"]),
    })
    expect(result.markdown).toContain(
      '# Japan macroeconomics: BoJ flags private-credit linkages — 2026-W18',
    )
    expect(result.markdown).toContain('subtopic_slug: "japan-macro--boj-private-credit"')
    expect(result.markdown).toContain(
      'subtopic_title: "BoJ flags private-credit linkages"',
    )
    expect(result.markdown).toContain('field_familiarity: "expert"')
    expect(result.markdown).toContain("subtopic_alternatives:")
    expect(result.markdown).toContain('slug: "japan-macro--takaichi-arms-exports"')
  })

  it("falls back to umbrella title when no subtopic was selected", async () => {
    const result = await runReport({
      periodLabel: "2026-W18",
      periodStart: "2026-04-21",
      periodEnd: "2026-04-28",
      generator: "stub",
      model: "stub-llm",
      promptHash: "sha256:" + "0".repeat(64),
      costUsd: 0,
      profileName: "Test",
      interestSlug: "japan-macro",
      interestTitle: "Japan macroeconomics",
      interestQuestion: null,
      interestTopics: ["japan-macro"],
      fieldFamiliarity: "novice",
      subtopic: null,
      subtopicAlternatives: [],
      analysis_md:
        "### Thesis\n\nUmbrella thesis [[alpha-source]].\n\n### Key developments\n\nDetails [[alpha-source]].\n\n### Cross-currents\n\nNo cross-currents.\n\n### Implications\n\nFlows [[alpha-source]].\n\n### Open questions\n\n- Watch the JGB curve.",
      items: [],
      candidates: cands,
      vaultSlugs: new Set(["alpha-source"]),
    })
    expect(result.markdown).toContain("# Japan macroeconomics — 2026-W18")
    expect(result.markdown).toContain("subtopic_slug: null")
    expect(result.markdown).toContain("subtopic_alternatives: []")
    expect(result.markdown).toContain('field_familiarity: "novice"')
  })
})

