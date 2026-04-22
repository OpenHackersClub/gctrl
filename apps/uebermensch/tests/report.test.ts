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
  type ReportSectionInput,
} from "../src/services/RendererService.js"
import { VaultService } from "../src/services/VaultService.js"

const seedPage = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${frontmatter}---\n\n${body}\n`, "utf8")
}

describe("weekly report (research interests + stub LLM + strict renderer)", () => {
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

  it("lists interests, scopes candidates per interest, and renders a report", async () => {
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

      const response = yield* llm.generateReport({
        periodLabel: "2026-W17",
        periodStart: "2026-04-15",
        periodEnd: "2026-04-22",
        profileName: "Test",
        interests: inputs,
        maxItemsPerInterest: 3,
      })
      expect(response.sections).toHaveLength(2)

      const bySlug = new Map(response.sections.map((s) => [s.interestSlug, s]))
      const sections: Array<ReportSectionInput> = inputs.map((ii) => {
        const s = bySlug.get(ii.slug)!
        return {
          interestSlug: ii.slug,
          interestTitle: ii.title,
          interestQuestion: ii.question,
          summary_md: s.summary_md,
          items: s.items,
          candidates: ii.candidates,
        }
      })

      const vaultSlugs = yield* vault.listSlugs()
      const rendered = yield* renderer.renderReport({
        periodLabel: "2026-W17",
        periodStart: "2026-04-15",
        periodEnd: "2026-04-22",
        generator: llm.name(),
        model: response.model,
        promptHash: response.promptHash,
        costUsd: response.costUsd,
        profileName: "Test",
        sections,
        vaultSlugs,
      })
      return yield* vault.writeReport("2026-W17", rendered.markdown)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(FileSystemVaultLive(vaultDir), StubLlmLive, StrictRendererLive),
      ),
    )

    const written = await Effect.runPromise(program)
    expect(written.relPath).toBe("reports/2026-W17.md")
    const onDisk = await readFile(join(vaultDir, written.relPath), "utf8")
    expect(onDisk).toContain("page_type: report")
    expect(onDisk).toContain("slug: report-2026-W17")
    expect(onDisk).toContain("[[2026-04-22--wikipedia-boj]]")
    expect(onDisk).toContain("[[2026-04-22--wikipedia-2026-senate]]")
    expect(onDisk).toContain("## Japan macro")
    expect(onDisk).toContain("## US 2026 midterms")
  })
})
