import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadDotenv } from "../src/lib/dotenv.js"

describe("loadDotenv", () => {
  const cwd = process.cwd()
  let dir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "uber-dotenv-")))
    process.chdir(dir)
    delete process.env.UBER_VAULT_DIR
  })

  afterEach(() => {
    process.chdir(cwd)
    delete process.env.UBER_VAULT_DIR
  })

  it("loads UBER_VAULT_DIR from .env in cwd", () => {
    writeFileSync(join(dir, ".env"), "UBER_VAULT_DIR=/tmp/my-vault\n")
    const loaded = loadDotenv()
    expect(loaded).toBe(join(dir, ".env"))
    expect(process.env.UBER_VAULT_DIR).toBe("/tmp/my-vault")
  })

  it("returns null when no .env is present", () => {
    expect(loadDotenv()).toBeNull()
  })
})
