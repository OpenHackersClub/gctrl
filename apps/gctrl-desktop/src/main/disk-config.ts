import { readFileSync } from "node:fs"
import path from "node:path"

/** Read the operator's directory allowlist for the packaged kernel. */
export function readDiskAllowlist(userDataPath: string, envOverride?: string): string | undefined {
  let raw: string
  if (envOverride?.trim()) {
    raw = envOverride
  } else {
    try {
      raw = readFileSync(path.join(userDataPath, "disk-allowlist.json"), "utf8")
    } catch {
      return undefined
    }
  }
  try {
    const paths: unknown = JSON.parse(raw)
    if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) {
      return undefined
    }
    return JSON.stringify(paths)
  } catch {
    return undefined
  }
}
