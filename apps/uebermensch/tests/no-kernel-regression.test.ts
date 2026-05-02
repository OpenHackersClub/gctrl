/**
 * Regression guard: brief generation must make zero kernel HTTP calls.
 *
 * Mechanism: replace globalThis.fetch with a vitest spy for the duration of
 * the test. The spy passes non-kernel URLs through to the real fetch so other
 * network I/O (if any) is unaffected. After running the exported
 * `makeBriefProgram` we assert that no call touched http://127.0.0.1:4318 or
 * the GCTRL_KERNEL_URL pattern.
 *
 * Manual sanity-check (performed before merging this file):
 *   1. In apps/uebermensch/src/commands/brief.ts, add a bare fetch call
 *      inside makeBriefProgram — e.g. after the writeBrief line:
 *        await fetch("http://127.0.0.1:4318/api/uber/briefs", { method: "POST" })
 *   2. Run: pnpm vitest run tests/no-kernel-regression.test.ts
 *   3. Confirm the test FAILS with a "expected 0 kernel fetch call(s)" message.
 *   4. Revert the temporary line before committing.
 *
 * If this test starts failing on a clean tree, a kernel fetch was re-introduced
 * somewhere in the brief pipeline (makeBriefProgram or its service dependencies).
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { StrictRendererLive } from "../src/adapters/StrictRenderer.js"
import { StubLlmLive } from "../src/adapters/StubLlm.js"
import { makeBriefProgram } from "../src/commands/brief.js"
import { ProfileService } from "../src/services/ProfileService.js"

// Kernel URL patterns that must not appear in any fetch call during the pipeline.
const KERNEL_PATTERN = /127\.0\.0\.1:4318|GCTRL_KERNEL_URL/

// Stub ProfileService that does not touch the filesystem.
const makeStubProfileLayer = () =>
  Layer.succeed(ProfileService, {
    load: () =>
      Effect.succeed({
        profile: {
          schema_version: 1,
          identity: { name: "Regression User", slug: "regression-user", tz: "UTC", lang: "en" },
          budgets: { daily_usd: 1, per_brief_usd: 0.5, max_tokens_per_brief: 4000 },
          delivery: {
            brief: { cron: "0 8 * * *", format: "short" as const },
            channels: {},
          },
        },
        topics: {
          topics: [
            { slug: "reg-topic", title: "Regression Topic", horizon: "short" as const, weight: 1 },
          ],
        },
        sources: { sources: [] },
        me: "",
        projects: "",
        avoid: "",
      }),
    validate: () => Effect.succeed([]),
  })

const seedPage = async (root: string, rel: string, frontmatter: string, body: string) => {
  const full = join(root, rel)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${frontmatter}---\n\n${body}\n`, "utf8")
}

describe("no-kernel regression — brief generation makes zero kernel fetch calls", () => {
  let vaultDir: string
  let originalFetch: typeof globalThis.fetch
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-no-kernel-"))
    await seedPage(
      vaultDir,
      "input/raw/2026-05-01--alpha.md",
      "page_type: source\nslug: 2026-05-01--alpha\ntitle: Alpha Source\ntopics: [reg-topic]\n",
      "# Alpha\n\nRegression content.",
    )

    // Install fetch spy: intercept all calls; pass non-kernel URLs through to
    // the real fetch so genuine external I/O is unaffected.
    originalFetch = globalThis.fetch
    mockFetch = vi.fn((...args: Parameters<typeof fetch>) => {
      const url = String(args[0])
      if (KERNEL_PATTERN.test(url)) {
        // Return a minimal ok response so the pipeline does not throw on
        // best-effort kernel calls (e.g. registerBriefInKernel).
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      return originalFetch(...args)
    })
    globalThis.fetch = mockFetch as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("writes a brief to the vault and calls fetch with NO kernel-shaped URLs", async () => {
    const date = "2026-05-01"

    const program = makeBriefProgram({
      date,
      sinceHours: 24,
      maxItemsOpt: Option.none(),
      dryRun: false,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeStubProfileLayer(),
          FileSystemVaultLive(vaultDir),
          StubLlmLive,
          StrictRendererLive,
        ),
      ),
    )

    const written = await Effect.runPromise(program)

    // 1. The brief was actually written to the vault — pipeline ran to completion.
    // dryRun is false so written is always defined; assert to satisfy the type checker.
    expect(written).toBeDefined()
    if (!written) throw new Error("expected written brief — dryRun was false")
    expect(written.relPath).toBe("input/briefs/2026-05-01.md")
    const onDisk = await readFile(join(vaultDir, written.relPath), "utf8")
    expect(onDisk).toContain("brief-2026-05-01")

    // 2. No fetch call touched a kernel-shaped URL.
    const kernelCalls = mockFetch.mock.calls.filter(([url]) =>
      KERNEL_PATTERN.test(String(url)),
    )
    expect(
      kernelCalls,
      `expected 0 kernel fetch call(s), got ${kernelCalls.length}: ${JSON.stringify(kernelCalls.map(([u]) => u))}`,
    ).toHaveLength(0)
  })
})
