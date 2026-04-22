import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { StrictRendererLive } from "../src/adapters/StrictRenderer.js"
import { StubLlmLive } from "../src/adapters/StubLlm.js"
import { selectCandidates } from "../src/lib/candidates.js"
import { LlmService } from "../src/services/LlmService.js"
import {
  RendererService,
  type ReportIndexEntry,
} from "../src/services/RendererService.js"
import { VaultService } from "../src/services/VaultService.js"

const seedPage = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${frontmatter}---\n\n${body}\n`, "utf8")
}

describe("weekly report (per-interest deep analysis + stub LLM + strict renderer)", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-vault-"))
    await seedPage(
      vaultDir,
      "research/japan-macro.md",
      'slug: japan-macro\ntitle: Japan macro\nquestion: "What is moving BoJ?"\ntopics: [japan-macro]\n',
      "# Japan macro interest",
    )
    await seedPage(
      vaultDir,
      "research/us-midterms-2026.md",
      'slug: us-midterms-2026\ntitle: US 2026 midterms\nquestion: "Which races are shifting?"\ntopics: [us-midterms-2026]\n',
      "# US midterms interest",
    )
    await seedPage(
      vaultDir,
      "wiki/sources/2026-04-22--wikipedia-boj.md",
      "page_type: source\nslug: 2026-04-22--wikipedia-boj\ntitle: Bank of Japan\ntopics: [japan-macro]\n",
      "# BoJ\n\nThe BoJ held its policy rate steady.",
    )
    await seedPage(
      vaultDir,
      "wiki/sources/2026-04-22--wikipedia-2026-senate.md",
      "page_type: source\nslug: 2026-04-22--wikipedia-2026-senate\ntitle: 2026 Senate\ntopics: [us-midterms-2026]\n",
      "# 2026 Senate\n\n33 Class 2 seats plus 2 specials are on the 2026 ballot.",
    )
  })

  it("generates one deep-analysis report file per interest + a weekly index", async () => {
    const program = Effect.gen(function* () {
      const vault = yield* VaultService
      const llm = yield* LlmService
      const renderer = yield* RendererService
      const interests = yield* vault.listResearchInterests()
      expect(interests.map((i) => i.slug).sort()).toEqual([
        "japan-macro",
        "us-midterms-2026",
      ])
      const pages = yield* vault.recentlyChanged(24)
      const now = new Date()

      const inputs = interests.map((it) => {
        const topicSet = new Set(it.topics)
        const scoped = pages.filter((p) => {
          const pt =
            (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []
          return pt.some((t) => topicSet.has(t))
        })
        const cands = selectCandidates({
          pages: scoped,
          topics: it.topics.map((t) => ({ slug: t, weight: 1 })),
          thesesSlugs: [],
          now,
          windowHours: 24,
          maxCandidates: 10,
        })
        return {
          slug: it.slug,
          title: it.title,
          question: it.question,
          topics: it.topics,
          notes: it.notes,
          candidates: cands,
        }
      })
      // Each interest sees only its own candidate.
      for (const ii of inputs) expect(ii.candidates).toHaveLength(1)

      const vaultSlugs = yield* vault.listSlugs()

      const written: Array<{
        readonly interestSlug: string
        readonly reportSlug: string
        readonly relPath: string
        readonly itemCount: number
      }> = []
      const entries: Array<ReportIndexEntry> = []

      for (const ii of inputs) {
        const response = yield* llm.generateInterestReport({
          periodLabel: "2026-W17",
          periodStart: "2026-04-15",
          periodEnd: "2026-04-22",
          profileName: "Test",
          interest: ii,
          maxItems: 3,
        })
        expect(response.interestSlug).toBe(ii.slug)
        expect(response.analysis_md).toContain("### Thesis")
        expect(response.items).toHaveLength(1)

        const rendered = yield* renderer.renderInterestReport({
          periodLabel: "2026-W17",
          periodStart: "2026-04-15",
          periodEnd: "2026-04-22",
          generator: llm.name(),
          model: response.model,
          promptHash: response.promptHash,
          costUsd: response.costUsd,
          profileName: "Test",
          interestSlug: ii.slug,
          interestTitle: ii.title,
          interestQuestion: ii.question,
          interestTopics: ii.topics,
          analysis_md: response.analysis_md,
          items: response.items,
          candidates: ii.candidates,
          vaultSlugs,
        })
        expect(rendered.slug).toBe(`2026-W17--${ii.slug}`)

        const w = yield* vault.writeReport(rendered.slug, rendered.markdown)
        written.push({
          interestSlug: ii.slug,
          reportSlug: rendered.slug,
          relPath: w.relPath,
          itemCount: rendered.itemCount,
        })
        entries.push({
          interestSlug: ii.slug,
          interestTitle: ii.title,
          interestQuestion: ii.question,
          reportSlug: rendered.slug,
          publicUrl: null,
          itemCount: rendered.itemCount,
          headline: response.analysis_md.slice(0, 80),
        })
      }

      const indexRendered = yield* renderer.renderReportIndex({
        periodLabel: "2026-W17",
        periodStart: "2026-04-15",
        periodEnd: "2026-04-22",
        generator: llm.name(),
        model: "stub-llm@0.1",
        totalCostUsd: 0,
        profileName: "Test",
        entries,
      })
      expect(indexRendered.slug).toBe("2026-W17")
      const writtenIndex = yield* vault.writeReport(
        indexRendered.slug,
        indexRendered.markdown,
      )

      return { written, writtenIndex }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(FileSystemVaultLive(vaultDir), StubLlmLive, StrictRendererLive),
      ),
    )

    const result = await Effect.runPromise(program)

    expect(result.writtenIndex.relPath).toBe("reports/2026-W17.md")
    const indexOnDisk = await readFile(
      join(vaultDir, result.writtenIndex.relPath),
      "utf8",
    )
    expect(indexOnDisk).toContain("page_type: report_index")
    expect(indexOnDisk).toContain('slug: report-2026-W17')
    expect(indexOnDisk).toContain("interest_count: 2")
    expect(indexOnDisk).toContain("Japan macro")
    expect(indexOnDisk).toContain("US 2026 midterms")

    expect(result.written.map((w) => w.reportSlug).sort()).toEqual([
      "2026-W17--japan-macro",
      "2026-W17--us-midterms-2026",
    ])

    const jpOnDisk = await readFile(
      join(vaultDir, "reports/2026-W17--japan-macro.md"),
      "utf8",
    )
    expect(jpOnDisk).toContain("page_type: report")
    expect(jpOnDisk).toContain('slug: report-2026-W17--japan-macro')
    expect(jpOnDisk).toContain('interest_slug: "japan-macro"')
    expect(jpOnDisk).toContain("### Thesis")
    expect(jpOnDisk).toContain("[[2026-04-22--wikipedia-boj]]")
    // The other interest's source must NOT appear in this file.
    expect(jpOnDisk).not.toContain("[[2026-04-22--wikipedia-2026-senate]]")

    const usOnDisk = await readFile(
      join(vaultDir, "reports/2026-W17--us-midterms-2026.md"),
      "utf8",
    )
    expect(usOnDisk).toContain('interest_slug: "us-midterms-2026"')
    expect(usOnDisk).toContain("[[2026-04-22--wikipedia-2026-senate]]")
    expect(usOnDisk).not.toContain("[[2026-04-22--wikipedia-boj]]")
  })
})
