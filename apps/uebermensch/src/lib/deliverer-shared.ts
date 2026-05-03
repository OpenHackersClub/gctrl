// Shared helpers for every DelivererService adapter (HttpDeliverer via
// kernel proxy, DirectDeliverer hitting providers directly). Lives here so
// the chunking / target-ref-resolution logic cannot drift across adapters.

import { Effect, Match, Option } from "effect"
import { DeliveryError } from "../errors.js"
import type { SecretsServiceImpl } from "../services/SecretsService.js"

// ---------------------------------------------------------------------------
// Per-channel max chunk lengths. Telegram's hard cap is 4096 chars, Discord
// 2000 — leave headroom for chunk-prefix + UTF8 safety.
// ---------------------------------------------------------------------------
export const TG_MAX = 3800
export const DC_MAX = 1900

export const splitChunks = (content: string, max: number): ReadonlyArray<string> => {
  if (content.length <= max) return [content]
  const chunks: Array<string> = []
  const lines = content.split("\n")
  let buf = ""
  for (const line of lines) {
    const next = buf.length === 0 ? line : `${buf}\n${line}`
    if (next.length > max && buf.length > 0) {
      chunks.push(buf)
      buf = line
    } else if (next.length > max) {
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
      buf = ""
    } else {
      buf = next
    }
  }
  if (buf.length > 0) chunks.push(buf)
  return chunks
}

export const stripFrontmatter = (md: string): string => {
  if (!md.startsWith("---\n")) return md
  const end = md.indexOf("\n---\n", 4)
  if (end === -1) return md
  return md.slice(end + 5).replace(/^\n+/, "")
}

const ITEM_HEADING = /^## \d+\. /m

export const splitBrief = (content: string, max: number): ReadonlyArray<string> => {
  const body = stripFrontmatter(content)
  if (!ITEM_HEADING.test(body)) return splitChunks(body, max)
  const withoutH1 = body.replace(/^#\s+[^\n]*\n+/, "")
  const parts = withoutH1
    .split(/(?=^## \d+\. )/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out: Array<string> = []
  for (const p of parts) {
    if (p.length <= max) out.push(p)
    else for (const c of splitChunks(p, max)) out.push(c)
  }
  return out
}

export const chunkPrefix = (i: number, total: number): string =>
  total > 1 ? `(${i + 1}/${total})\n` : ""

// ---------------------------------------------------------------------------
// Target-ref resolution — `<prefix>env:<KEY>` → secrets.get(KEY),
// `<prefix><value>` → literal. Pure parser delegates env reads to
// SecretsService so a future LocalKeychain/KernelSecrets adapter swaps in
// without touching this file.
// ---------------------------------------------------------------------------
export const resolveEnvRef = (
  targetRef: string,
  prefix: string,
): { kind: "env"; key: string } | { kind: "literal"; value: string } | null => {
  if (!targetRef.startsWith(prefix)) return null
  const rest = targetRef.slice(prefix.length)
  if (rest.startsWith("env:")) return { kind: "env", key: rest.slice(4) }
  return { kind: "literal", value: rest }
}

export const configErr = (channel: string, driver: string, message: string): DeliveryError =>
  new DeliveryError({ message, channel, driver, kind: "config" })

export const resolveRef = (
  secrets: SecretsServiceImpl,
  targetRef: string,
  prefix: string,
  channel: string,
  driver: string,
): Effect.Effect<string, DeliveryError> => {
  const unresolved = () =>
    configErr(channel, driver, `unresolved target_ref for ${driver}: ${targetRef}`)
  const parsed = resolveEnvRef(targetRef, prefix)
  if (parsed === null) return Effect.fail(unresolved())
  return Match.value(parsed).pipe(
    Match.discriminator("kind")("literal", ({ value }) => Effect.succeed(value)),
    Match.discriminator("kind")("env", ({ key }) =>
      secrets.get(key).pipe(
        Effect.catchTag("SecretsError", (e) =>
          Effect.fail(
            configErr(
              channel,
              driver,
              `secret lookup failed for ${driver} (key=${key}): ${e.message}`,
            ),
          ),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(unresolved()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Match.exhaustive,
  )
}

// ---------------------------------------------------------------------------
// HTTP status → DeliveryError kind. 5xx is network/health (retry-eligible);
// 4xx is a client/config problem (don't retry).
// ---------------------------------------------------------------------------
export const classifyHttpStatus = (
  status: number,
): "config" | "unreachable" | "rate_limited" | "invalid" | "io_failure" =>
  Match.value(status).pipe(
    Match.when(429, () => "rate_limited" as const),
    Match.whenOr(502, 503, 504, () => "unreachable" as const),
    Match.when((n) => n >= 500, () => "unreachable" as const),
    Match.whenOr(400, 401, 403, 404, () => "invalid" as const),
    Match.orElse(() => "io_failure" as const),
  )

export const unreachableErr = (
  path: string,
  channel: string,
  driver: string,
  reason: string,
): DeliveryError =>
  new DeliveryError({
    message: `${path} ${reason}`,
    channel,
    driver,
    kind: "unreachable",
  })
