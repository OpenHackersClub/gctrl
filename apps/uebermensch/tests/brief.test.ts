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
import { RendererService } from "../src/services/RendererService.js"
import { VaultService } from "../src/services/VaultService.js"

const seedPage = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${frontmatter}---\n\n${body}\n`, "utf8")
}

describe("brief generation (candidates + stub LLM + strict renderer)", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-vault-"))
    await seedPage(
      vaultDir,
      "wiki/sources/2026-04-18--foo.md",
      "page_type: source\nslug: 2026-04-18--foo\ntitle: Foo Source\ntopics: [foo-topic]\n",
      "# Foo\n\nSome content.",
    )
    await seedPage(
      vaultDir,
      "wiki/sources/2026-04-18--bar.md",
      "page_type: source\nslug: 2026-04-18--bar\ntitle: Bar Source\ntopics: [bar-topic]\n",
      "# Bar\n\nOther content.",
    )
  })

  it("writes a brief with frontmatter + resolved citations", async () => {
    const program = Effect.gen(function* () {
      const vault = yield* VaultService
      const llm = yield* LlmService
      const renderer = yield* RendererService
      const pages = yield* vault.recentlyChanged(24)
      const candidates = selectCandidates({
        pages,
        topics: [
          { slug: "foo-topic", weight: 1 },
          { slug: "bar-topic", weight: 1 },
        ],
        thesesSlugs: [],
        now: new Date(),
        windowHours: 24,
        maxCandidates: 40,
      })
      const response = yield* llm.generateBrief({
        date: "2026-04-19",
        profileName: "Test",
        topics: ["foo-topic", "bar-topic"],
        thesesSlugs: [],
        candidates,
        maxItems: 6,
      })
      const vaultSlugs = yield* vault.listSlugs()
      const rendered = yield* renderer.render({
        date: "2026-04-19",
        generator: llm.name(),
        model: response.model,
        promptHash: response.promptHash,
        costUsd: response.costUsd,
        profileName: "Test",
        topicsCovered: response.topicsCovered,
        thesesCovered: response.thesesCovered,
        candidates,
        items: response.items,
        vaultSlugs,
      })
      return yield* vault.writeBrief("2026-04-19", rendered.markdown)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(FileSystemVaultLive(vaultDir), StubLlmLive, StrictRendererLive),
      ),
    )

    const written = await Effect.runPromise(program)
    expect(written.relPath).toBe("briefs/2026-04-19.md")
    expect(written.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const onDisk = await readFile(join(vaultDir, written.relPath), "utf8")
    expect(onDisk).toContain("brief-2026-04-19")
    expect(onDisk).toContain("prompt_hash:")
    expect(onDisk).toContain("[[2026-04-18--foo]]")
  })
})
