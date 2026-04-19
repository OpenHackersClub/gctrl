import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { StubLlmLive } from "../src/adapters/StubLlm.js"
import { LlmService } from "../src/services/LlmService.js"
import { VaultService } from "../src/services/VaultService.js"

const seedPage = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${frontmatter}---\n\n${body}\n`, "utf8")
}

describe("brief generation (vault + stub LLM)", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-vault-"))
    await seedPage(
      vaultDir,
      "wiki/topics/foo.md",
      "page_type: topic\nslug: foo\ntitle: Foo\n",
      "# Foo\n\nSome content.",
    )
    await seedPage(
      vaultDir,
      "wiki/topics/bar.md",
      "page_type: topic\nslug: bar\ntitle: Bar\n",
      "# Bar\n\nOther content.",
    )
  })

  afterEach(async () => {
    // temp dir — OS cleans up
  })

  it("writes a brief file to briefs/<date>.md with content hash", async () => {
    const program = Effect.gen(function* () {
      const vault = yield* VaultService
      const llm = yield* LlmService
      const pages = yield* vault.recentlyChanged(24)
      const response = yield* llm.generateBrief({
        date: "2026-04-19",
        profileName: "Test",
        pages,
        topics: ["foo", "bar"],
      })
      const rendered = `---\npage_type: brief\nslug: brief-2026-04-19\n---\n\n${response.items
        .map((i) => `### ${i.heading}\n\n${i.body}\n`)
        .join("\n")}`
      return yield* vault.writeBrief("2026-04-19", rendered)
    }).pipe(
      Effect.provide(Layer.merge(FileSystemVaultLive(vaultDir), StubLlmLive)),
    )

    const written = await Effect.runPromise(program)
    expect(written.relPath).toBe("briefs/2026-04-19.md")
    expect(written.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const onDisk = await readFile(join(vaultDir, written.relPath), "utf8")
    expect(onDisk).toContain("brief-2026-04-19")
    expect(onDisk).toContain("[[foo]]")
  })
})
