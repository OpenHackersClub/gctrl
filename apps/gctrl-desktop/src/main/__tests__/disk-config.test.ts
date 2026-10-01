import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { readDiskAllowlist } from "../disk-config"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it("loads absolute allowlisted directories for the packaged kernel", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gctrl-disk-config-"))
  dirs.push(dir)
  writeFileSync(path.join(dir, "disk-allowlist.json"), JSON.stringify(["/srv/project", "/srv/cache"]))
  expect(readDiskAllowlist(dir)).toBe('["/srv/project","/srv/cache"]')
})

it("rejects relative paths and invalid config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gctrl-disk-config-"))
  dirs.push(dir)
  writeFileSync(path.join(dir, "disk-allowlist.json"), JSON.stringify(["relative/path"]))
  expect(readDiskAllowlist(dir)).toBeUndefined()
  expect(readDiskAllowlist(dir, '["/tmp", "relative/path"]')).toBeUndefined()
})
