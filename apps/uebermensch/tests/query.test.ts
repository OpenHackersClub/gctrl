import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import matter from "gray-matter"
import { beforeEach, describe, expect, it } from "vitest"
import { FileSystemQueryLive } from "../src/adapters/FileSystemQuery.js"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { StubLlmLive } from "../src/adapters/StubLlm.js"
import { LlmService } from "../src/services/LlmService.js"
import { QueryService } from "../src/services/QueryService.js"
import { VaultService } from "../src/services/VaultService.js"

const seedFile = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  const fm = frontmatter.trim().length === 0 ? "" : `---\n${frontmatter}---\n\n`
  await writeFile(full, `${fm}${body}\n`, "utf8")
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe("prompts (user research queries)", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-vault-prompts-"))
    await seedFile(
      vaultDir,
      "directives/prompts/what-is-claudes-real-moat.md",
      'slug: what-is-claudes-real-moat\ntitle: "What is Claude\'s real moat?"\ntopics: [ai-dev-workflows]\nkind: query\n',
      "Some half-formed thoughts:\n\n- Tooling ergonomics?\n- Distribution via Claude Code?",
    )
    await seedFile(
      vaultDir,
      "directives/prompts/no-frontmatter-question.md",
      "",
      "What does the wiki say about prediction markets?",
    )
    await seedFile(
      vaultDir,
      "input/raw/2026-04-22--anthropic-claude-code.md",
      "page_type: source\nslug: 2026-04-22--anthropic-claude-code\ntitle: Anthropic Claude Code launch\ntopics: [ai-dev-workflows]\n",
      "Anthropic launched Claude Code, a CLI agent.",
    )
    await seedFile(
      vaultDir,
      "input/raw/2026-04-20--kalshi-volume.md",
      "page_type: source\nslug: 2026-04-20--kalshi-volume\ntitle: Kalshi weekly volume\ntopics: [prediction-market]\n",
      "Kalshi reported $42M weekly volume.",
    )
  })

  it("lists prompts including ones without frontmatter", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        return yield* q.list()
      }).pipe(Effect.provide(FileSystemQueryLive(vaultDir))),
    )
    const slugs = result.map((p) => p.slug).sort()
    expect(slugs).toEqual(["no-frontmatter-question", "what-is-claudes-real-moat"])
    const claude = result.find((p) => p.slug === "what-is-claudes-real-moat")
    expect(claude?.status).toBe("pending")
    expect(claude?.topics).toEqual(["ai-dev-workflows"])
    expect(claude?.kind).toBe("query")
    const noFm = result.find((p) => p.slug === "no-frontmatter-question")
    expect(noFm?.status).toBe("pending")
    expect(noFm?.topics).toEqual([])
    // Default kind is `thought` — unstructured notes get the intent →
    // questions → sources → thesis-update pipeline, not Q&A consolidation.
    expect(noFm?.kind).toBe("thought")
  })

  it("processes a pending prompt: writes input/reports/<slug>.md and stamps frontmatter", async () => {
    const layer = Layer.mergeAll(
      FileSystemQueryLive(vaultDir),
      FileSystemVaultLive(vaultDir),
      StubLlmLive,
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        const v = yield* VaultService
        const llm = yield* LlmService
        const prompt = yield* q.get("what-is-claudes-real-moat")
        // Pull wiki context like the command does (topic match)
        const pages = yield* v.listWikiPages()
        const matched = pages.filter((p) => {
          const topics = (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? []
          return prompt.topics.some((t) => topics.includes(t))
        })
        expect(matched.map((p) => p.stem).sort()).toEqual([
          "2026-04-22--anthropic-claude-code",
        ])
        const res = yield* llm.researchQuery({
          slug: prompt.slug,
          title: prompt.title,
          topics: prompt.topics,
          question: prompt.body,
          profileName: "Test User",
          contextPages: matched.map((p) => ({
            stem: p.stem,
            title: (p.frontmatter.title as string | undefined) ?? p.stem,
            topics: (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? [],
            excerpt: p.body,
          })),
        })
        expect(res.answerMd).toContain("[[2026-04-22--anthropic-claude-code]]")
        const written = yield* v.writeResearch(prompt.slug, res.answerMd)
        expect(written.relPath).toBe("input/reports/what-is-claudes-real-moat.md")
        yield* q.stamp(prompt.slug, {
          status: "processed",
          output: written.relPath,
          processedAt: "2026-04-25T08:14:11Z",
          contentHash: written.contentHash,
          promptHash: res.promptHash,
          model: res.model,
          costUsd: res.costUsd,
        })
      }).pipe(Effect.provide(layer)),
    )

    const writtenAbs = join(vaultDir, "input", "reports", "what-is-claudes-real-moat.md")
    expect(await fileExists(writtenAbs)).toBe(true)
    const written = await readFile(writtenAbs, "utf8")
    expect(written).toContain("Stub research consolidation")

    const promptAbs = join(vaultDir, "directives", "prompts", "what-is-claudes-real-moat.md")
    const updated = matter(await readFile(promptAbs, "utf8"))
    expect(updated.data.status).toBe("processed")
    expect(updated.data.output).toBe("input/reports/what-is-claudes-real-moat.md")
    expect(updated.data.processed_at).toBe("2026-04-25T08:14:11Z")
    expect(updated.data.content_hash).toMatch(/^sha256:/)
    expect(updated.data.prompt_hash).toMatch(/^sha256:/)
    expect(updated.data.model).toBe("stub-llm@0.1")
    expect(updated.data.title).toBe("What is Claude's real moat?")
    // Body must be untouched
    expect(updated.content.trim()).toContain("Tooling ergonomics?")
  })

  it("stamping a missing slug fails with not_found", async () => {
    const program = Effect.gen(function* () {
      const q = yield* QueryService
      return yield* q.stamp("does-not-exist", {
        status: "processed",
        processedAt: new Date().toISOString(),
      })
    }).pipe(Effect.provide(FileSystemQueryLive(vaultDir)))
    const result = await Effect.runPromise(Effect.either(program))
    expect(result._tag).toBe("Left")
  })

  it("derives slug from filename when frontmatter has none", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        return yield* q.get("no-frontmatter-question")
      }).pipe(Effect.provide(FileSystemQueryLive(vaultDir))),
    )
    expect(result.slug).toBe("no-frontmatter-question")
    expect(result.title).toBe("No frontmatter question")
    expect(result.body.trim()).toBe("What does the wiki say about prediction markets?")
  })

  it("processes a thought-kind prompt: writes structured report, archives source", async () => {
    // Drop a fresh thought-kind note: no title, no topics, no kind frontmatter.
    // The processor should default it to `thought`, run analyzeThought, write
    // an input/reports/<slug>.md with intent/questions/sources/thesis sections,
    // and rename the source to directives/prompts/archived/<slug>.md.
    await seedFile(
      vaultDir,
      "directives/prompts/half-formed-thought.md",
      "",
      "Wondering whether Claude Code's CLI distribution moat is durable.",
    )
    // Seed one thesis so analyzeThought has something to map onto.
    await seedFile(
      vaultDir,
      "directives/theses/ai-dev-tooling.md",
      "slug: ai-dev-tooling\ntitle: AI dev tooling consolidation\ntopics: [ai-dev-workflows]\n",
      "Tools that own distribution own the workflow.",
    )

    const layer = Layer.mergeAll(
      FileSystemQueryLive(vaultDir),
      FileSystemVaultLive(vaultDir),
      StubLlmLive,
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        const v = yield* VaultService
        const llm = yield* LlmService
        const prompt = yield* q.get("half-formed-thought")
        expect(prompt.kind).toBe("thought")

        const pages = yield* v.listWikiPages()
        const theses = yield* v.listTheses()
        expect(theses.map((t) => t.slug)).toContain("ai-dev-tooling")

        const res = yield* llm.analyzeThought({
          slug: prompt.slug,
          title: prompt.title,
          topics: prompt.topics,
          note: prompt.body,
          profileName: "Test User",
          contextPages: pages.map((p) => ({
            stem: p.stem,
            title: (p.frontmatter.title as string | undefined) ?? p.stem,
            topics:
              (p.frontmatter.topics as ReadonlyArray<string> | undefined) ?? [],
            excerpt: p.body,
          })),
          theses: theses.map((t) => ({
            slug: t.slug,
            title: t.title,
            topics: t.topics,
            excerpt: t.body,
          })),
        })
        expect(res.analysis.questions.length).toBeGreaterThan(0)
        expect(res.analysis.thesisUpdates[0]?.thesisSlug).toBe("ai-dev-tooling")

        const written = yield* v.writeResearch(
          prompt.slug,
          `## Intent\n\n${res.analysis.intent}\n`,
        )
        expect(written.relPath).toBe("input/reports/half-formed-thought.md")
        yield* q.stamp(prompt.slug, {
          status: "processed",
          output: written.relPath,
          processedAt: "2026-05-03T00:00:00Z",
          contentHash: written.contentHash,
          promptHash: res.promptHash,
          model: res.model,
          costUsd: res.costUsd,
        })
        const archived = yield* q.archive(prompt.slug)
        expect(archived.toRelPath).toBe(
          "directives/prompts/archived/half-formed-thought.md",
        )
      }).pipe(Effect.provide(layer)),
    )

    // Source file moved
    expect(
      await fileExists(
        join(vaultDir, "directives", "prompts", "half-formed-thought.md"),
      ),
    ).toBe(false)
    expect(
      await fileExists(
        join(
          vaultDir,
          "directives",
          "prompts",
          "archived",
          "half-formed-thought.md",
        ),
      ),
    ).toBe(true)

    // list() must NOT surface archived prompts — the inbox stays clean.
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        return yield* q.list()
      }).pipe(Effect.provide(FileSystemQueryLive(vaultDir))),
    )
    expect(remaining.map((p) => p.slug)).not.toContain("half-formed-thought")
  })

  it("archive fails with collision when target already exists", async () => {
    await seedFile(
      vaultDir,
      "directives/prompts/dup.md",
      "",
      "an idea",
    )
    await seedFile(
      vaultDir,
      "directives/prompts/archived/dup.md",
      "",
      "older copy already there",
    )
    const program = Effect.gen(function* () {
      const q = yield* QueryService
      return yield* q.archive("dup")
    }).pipe(Effect.provide(FileSystemQueryLive(vaultDir)))
    const result = await Effect.runPromise(Effect.either(program))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.kind).toBe("collision")
    }
  })

  it("returns empty list when directives/prompts/ directory does not exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "uber-vault-empty-"))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* QueryService
        return yield* q.list()
      }).pipe(Effect.provide(FileSystemQueryLive(empty))),
    )
    expect(result).toEqual([])
  })
})
