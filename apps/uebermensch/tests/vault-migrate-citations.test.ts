import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import matter from "gray-matter"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sha256 } from "../src/lib/hash.js"
import type { SourceDigest } from "../src/lib/llm-prompts.js"
import { LlmService } from "../src/services/LlmService.js"
import { makeMigrationProgram } from "../src/commands/vault-migrate-citations.js"

// ---- helpers ----------------------------------------------------------------

const seedFile = async (path: string, content: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

const fmDoc = (fm: Record<string, unknown>, body: string): string =>
  matter.stringify(body, fm)

/** Build a minimal brief .md that cites a given set of source slugs. */
const briefContent = (date: string, sourcePageIds: ReadonlyArray<string>): string => {
  const items = sourcePageIds.map((id, i) => ({
    kind: "news",
    title: `Item ${i + 1}`,
    summary_md: `Summary [${i + 1}].`,
    topic: null,
    thesis: null,
    references: [
      {
        n: 1,
        source_page_id: id,
        canonical_url: `https://example.com/${id}`,
        accessed_at: `${date}T00:00:00Z`,
        title: `Stub ${id}`,
        domain: "example.com",
      },
    ],
    suggested_action: null,
  }))
  return fmDoc(
    {
      page_type: "brief",
      slug: `brief-${date}`,
      generated_for: date,
      items,
    },
    "",
  )
}

// ---- StubLlm layer with Citation Mode v1 SourceSummaryResponse shape --------

const STUB_DIGEST: SourceDigest = {
  gist: ["Stub gist bullet 1.", "Stub gist bullet 2."],
  key_numbers: ["42%"],
  essential_quotes: [{ text: "Stub quote.", attribution: "Stub author" }],
  access: "open",
}

const makeMigrationStubLlm = (calls: { count: number }) =>
  Layer.succeed(LlmService, {
    name: () => "stub-migration-llm@0.1",
    generateBrief: () => Effect.die("not used"),
    proposeSubtopic: () => Effect.die("not used"),
    generateInterestReport: () => Effect.die("not used"),
    researchQuery: () => Effect.die("not used"),
    generateProbes: () => Effect.die("not used"),
    summarizeSource: (req) =>
      Effect.sync(() => {
        calls.count += 1
        return {
          digest: STUB_DIGEST,
          promptHash: sha256(`stub\n${req.url}\n${req.text}`),
          costUsd: 0.0001,
          model: "stub-migration-llm@0.1",
        }
      }),
  })

// ---- fixture ----------------------------------------------------------------

type VaultFixture = {
  vaultDir: string
  sourceSlugs: { cited: string; long1: string; long2: string }
}

const buildFixture = async (): Promise<VaultFixture> => {
  const vaultDir = await mkdtemp(join(tmpdir(), "uber-migrate-"))

  // 3 source pages without digest_version
  const cited = "2026-04-10--anthropic-com--model-release"
  const long1 = "2026-04-01--openai-com--gpt5"
  const long2 = "2026-03-20--example-com--older-story"

  const sourceBody = (slug: string) =>
    fmDoc(
      {
        page_type: "source",
        slug,
        title: `Title: ${slug}`,
        url: `https://example.com/${slug}`,
        topics: ["ai"],
      },
      `# ${slug}\n\nSome content about the story.`,
    )

  await seedFile(join(vaultDir, "input/raw", `${cited}.md`), sourceBody(cited))
  await seedFile(join(vaultDir, "input/raw", `${long1}.md`), sourceBody(long1))
  await seedFile(join(vaultDir, "input/raw", `${long2}.md`), sourceBody(long2))

  // 1 brief dated within last 30 days, citing `cited`
  const recentDateStr = new Date().toISOString().slice(0, 10)
  await seedFile(
    join(vaultDir, "input/briefs", `${recentDateStr}.md`),
    briefContent(recentDateStr, [cited]),
  )

  return { vaultDir, sourceSlugs: { cited, long1, long2 } }
}

// ---- default migration args -------------------------------------------------

const defaultArgs = (vaultDir: string, isDryRun: boolean) => ({
  vaultDir,
  isDryRun,
  lookbackDays: 30,
  max: 80,
  all: false,
  archiveDir: "input/archive/raw-pre-digest/",
})

// ---- tests ------------------------------------------------------------------

describe("vault migrate-citations", () => {
  let fixture: VaultFixture

  beforeEach(async () => {
    fixture = await buildFixture()
  })

  it("dry-run: calls LLM for 1 high-traffic page, marks 2 long-tail as pending, writes nothing", async () => {
    const calls = { count: 0 }
    const stubLayer = makeMigrationStubLlm(calls)

    await Effect.runPromise(
      makeMigrationProgram(defaultArgs(fixture.vaultDir, true)).pipe(
        Effect.provide(stubLayer),
      ),
    )

    // LLM called once — only for the cited (high-traffic) page
    expect(calls.count).toBe(1)

    // No files modified — dry-run
    const citedPath = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.cited}.md`)
    const citedParsed = matter(await readFile(citedPath, "utf8"))
    expect(citedParsed.data.digest_version).toBeUndefined()

    const long1Path = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.long1}.md`)
    const long1Parsed = matter(await readFile(long1Path, "utf8"))
    expect(long1Parsed.data.pending_digest).toBeUndefined()

    const long2Path = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.long2}.md`)
    const long2Parsed = matter(await readFile(long2Path, "utf8"))
    expect(long2Parsed.data.pending_digest).toBeUndefined()
  })

  it("apply: redigests high-traffic page, archives original, appends NDJSON log, marks long-tail pending", async () => {
    const calls = { count: 0 }
    const stubLayer = makeMigrationStubLlm(calls)

    await Effect.runPromise(
      makeMigrationProgram(defaultArgs(fixture.vaultDir, false)).pipe(
        Effect.provide(stubLayer),
      ),
    )

    // LLM called once for the cited page
    expect(calls.count).toBe(1)

    // Cited page: body now has "## Gist" heading, frontmatter updated
    const citedPath = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.cited}.md`)
    const citedOnDisk = await readFile(citedPath, "utf8")
    const citedParsed = matter(citedOnDisk)
    expect(citedParsed.data.digest_version).toBe(1)
    expect(citedParsed.data.pending_digest).toBe(false)
    expect(citedParsed.content).toContain("## Gist")
    expect(citedParsed.content).toContain("Stub gist bullet 1.")

    // Original archived under input/archive/raw-pre-digest/
    const archivePath = join(
      fixture.vaultDir,
      "input/archive/raw-pre-digest",
      `${fixture.sourceSlugs.cited}.md`,
    )
    const archiveContent = await readFile(archivePath, "utf8")
    const archiveParsed = matter(archiveContent)
    // Archive is the pre-migration original — no digest_version
    expect(archiveParsed.data.digest_version).toBeUndefined()

    // NDJSON log appended with correct fields
    const logPath = join(fixture.vaultDir, "input/archive/migration-citation-v1.ndjson")
    const logContent = await readFile(logPath, "utf8")
    const logLine = JSON.parse(logContent.trim().split("\n")[0])
    expect(logLine.slug).toBe(fixture.sourceSlugs.cited)
    expect(logLine.status).toBe("digested")
    expect(logLine.digest_version).toBe(1)
    expect(logLine.model).toBe("stub-migration-llm@0.1")
    expect(logLine.digested_at).toBeDefined()

    // Long-tail pages: pending_digest: true, body unchanged
    const long1Path = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.long1}.md`)
    const long1Parsed = matter(await readFile(long1Path, "utf8"))
    expect(long1Parsed.data.pending_digest).toBe(true)
    expect(long1Parsed.content).toContain("Some content about the story.")

    const long2Path = join(fixture.vaultDir, "input/raw", `${fixture.sourceSlugs.long2}.md`)
    const long2Parsed = matter(await readFile(long2Path, "utf8"))
    expect(long2Parsed.data.pending_digest).toBe(true)
  })

  it("skips pages that already have digest_version >= 1", async () => {
    const calls = { count: 0 }
    const stubLayer = makeMigrationStubLlm(calls)

    // Seed an already-migrated page (will be cited in the brief too)
    const alreadyDone = "2026-04-15--done-com--already-done"
    await seedFile(
      join(fixture.vaultDir, "input/raw", `${alreadyDone}.md`),
      fmDoc(
        {
          page_type: "source",
          slug: alreadyDone,
          title: "Already done",
          url: "https://done.com/already-done",
          topics: ["ai"],
          digest_version: 1,
        },
        "## Gist\n\n- already digested",
      ),
    )

    await Effect.runPromise(
      makeMigrationProgram(defaultArgs(fixture.vaultDir, false)).pipe(
        Effect.provide(stubLayer),
      ),
    )

    // Only 1 LLM call — the already-done page is skipped even if cited
    expect(calls.count).toBe(1)
  })
})
