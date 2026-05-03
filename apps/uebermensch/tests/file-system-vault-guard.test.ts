import { access, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { FileSystemVaultLive } from "../src/adapters/FileSystemVault.js"
import { VaultSecretLeakError } from "../src/errors.js"
import { VaultService } from "../src/services/VaultService.js"

// These tests prove the production VaultService write path is wrapped by
// VaultSecretGuard — i.e. the guard is load-bearing, not just shipped. The
// foundation PR (#145) introduced the guard but did not wire it. Slice 7
// flips it on by routing FileSystemVaultLive's writes through VaultWriterPort,
// which the guard middleware wraps. If a future refactor reintroduces a write
// path that bypasses the port, the brief/source/report fixtures here will
// start succeeding and the test fails.

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Split-prefix to keep GitHub's push-time secret scanner from flagging this
// source file. Same trick as tests/vault-secret-guard.test.ts.
const ANTHROPIC_LEAK = `${"sk-ant" + "-api03-DeadBeefDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef"}`

const runWithVault = <A, E>(dir: string, eff: Effect.Effect<A, E, VaultService>) =>
  Effect.runPromise(Effect.exit(Effect.provide(eff, FileSystemVaultLive(dir))))

describe("FileSystemVaultLive — secret guard is load-bearing", () => {
  it("writeBrief blocks content containing an Anthropic API key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-vault-guard-"))
    const exit = await runWithVault(
      dir,
      Effect.gen(function* () {
        const vault = yield* VaultService
        return yield* vault.writeBrief("2026-05-02", `# brief\n\ntoken: ${ANTHROPIC_LEAK}`)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as unknown as { error: unknown }).error
      expect(err).toBeInstanceOf(VaultSecretLeakError)
      const leak = err as VaultSecretLeakError
      expect(leak.leaks[0]?.name).toBe("anthropic_api_key")
    }

    // Briefs dir should not even exist — the write was rejected before mkdir.
    const briefsExists = await fileExists(join(dir, "input", "briefs"))
    expect(briefsExists).toBe(false)
  })

  it("writeBrief allows clean content and writes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-vault-guard-"))
    const exit = await runWithVault(
      dir,
      Effect.gen(function* () {
        const vault = yield* VaultService
        return yield* vault.writeBrief("2026-05-02", "# brief\n\nclean content here")
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    const files = await readdir(join(dir, "input", "briefs"))
    expect(files).toContain("2026-05-02.md")
  })

  it("writeSource blocks content containing a GitHub PAT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-vault-guard-"))
    const pat = `${"ghp" + "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm"}`
    const exit = await runWithVault(
      dir,
      Effect.gen(function* () {
        const vault = yield* VaultService
        return yield* vault.writeSource("evil-source", `body ${pat}`)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as unknown as { error: unknown }).error
      expect(err).toBeInstanceOf(VaultSecretLeakError)
    }
    const rawExists = await fileExists(join(dir, "input", "raw", "evil-source.md"))
    expect(rawExists).toBe(false)
  })

  it("writeReport blocks leaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-vault-guard-"))
    const exit = await runWithVault(
      dir,
      Effect.gen(function* () {
        const vault = yield* VaultService
        return yield* vault.writeReport("q2-thesis", `summary: ${ANTHROPIC_LEAK}`)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const reportExists = await fileExists(join(dir, "input", "reports", "q2-thesis.md"))
    expect(reportExists).toBe(false)
  })

  it("writeResearch blocks leaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uber-vault-guard-"))
    const exit = await runWithVault(
      dir,
      Effect.gen(function* () {
        const vault = yield* VaultService
        return yield* vault.writeResearch("interest-x", `notes ${ANTHROPIC_LEAK}`)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const researchExists = await fileExists(
      join(dir, "input", "reports", "interest-x.md"),
    )
    expect(researchExists).toBe(false)
  })
})
