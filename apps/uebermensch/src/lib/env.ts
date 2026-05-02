import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect } from "effect"
import { VaultError } from "../errors.js"

export const publicBaseUrl = (): string | null => {
  const raw = process.env.UBER_PUBLIC_BASE_URL
  if (!raw) return null
  const trimmed = raw.trim().replace(/\/+$/, "")
  return trimmed.length > 0 ? trimmed : null
}

export const publicReportUrl = (slug: string): string | null => {
  const base = publicBaseUrl()
  return base ? `${base}/reports/${encodeURIComponent(slug)}` : null
}

export const publicBriefUrl = (date: string): string | null => {
  const base = publicBaseUrl()
  return base ? `${base}/briefs/${encodeURIComponent(date)}` : null
}

// Whether the configured hosted-link backend requires an R2 upload before chat
// fan-out. Cloudflare Pages reads the vault from R2 → sync required. Tailscale
// Serve / localhost / any self-hosted setup serves the vault directly from the
// local filesystem → sync not applicable. Override with UBER_HOSTED_SYNC=none.
export const requiresR2Sync = (baseUrl: string | null): boolean => {
  const override = (process.env.UBER_HOSTED_SYNC ?? "").trim().toLowerCase()
  if (override === "none" || override === "off" || override === "false") return false
  if (override === "r2" || override === "on" || override === "true") return true
  if (!baseUrl) return true
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return true
  }
  if (host.endsWith(".ts.net")) return false
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false
  if (host.endsWith(".local")) return false
  return true
}

export const resolveVaultDir = () =>
  Effect.gen(function* () {
    const env = process.env.UBER_VAULT_DIR
    if (!env || env.trim() === "") {
      return yield* Effect.fail(
        new VaultError({
          message:
            "UBER_VAULT_DIR is not set. Run `uber vault init <path>` then `export UBER_VAULT_DIR=<path>`.",
        }),
      )
    }
    const abs = resolve(env)
    yield* Effect.tryPromise({
      try: () => access(abs),
      catch: () =>
        new VaultError({
          message: `UBER_VAULT_DIR does not exist: ${abs}`,
          path: abs,
        }),
    })
    return abs
  })
