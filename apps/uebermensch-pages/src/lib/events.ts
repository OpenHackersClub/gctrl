// Read + mutate event suggestions in R2. Mirrors the local CLI's accept/dismiss
// flow (apps/uebermensch/src/adapters/FileSystemCalendar.ts). The local daemon's
// bidirectional R2 sync reflects these changes back into $UBER_VAULT_DIR within
// one pull cycle.

import matter from "gray-matter"
import { listUnder, SAFE_KEY_RE } from "./vault.ts"

const SUGGESTED_PREFIX = "calendar/suggested/"
const CONFIRMED_PREFIX = "calendar/"

export type Suggestion = Readonly<{
  key: string
  slug: string
  title: string
  startsAt: string
  endsAt: string | null
  tz: string
  status: "tentative" | "confirmed" | "cancelled"
  location: string | null
  url: string | null
  topics: ReadonlyArray<string>
  tags: ReadonlyArray<string>
  matchScore: number | null
  matchedTerms: ReadonlyArray<string>
}>

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null

const asArray = (v: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

const decodeSuggestion = (key: string, raw: string): Suggestion | null => {
  const parsed = matter(raw)
  const fm = (parsed.data ?? {}) as Record<string, unknown>
  const slug = asString(fm.slug)
  const title = asString(fm.title)
  const startsAt = asString(fm.starts_at)
  const tz = asString(fm.tz)
  const status = asString(fm.status)
  if (!slug || !title || !startsAt || !tz) return null
  if (status !== "tentative" && status !== "confirmed" && status !== "cancelled") return null
  const links = Array.isArray(fm.links)
    ? (fm.links as ReadonlyArray<Record<string, unknown>>)
    : []
  const firstLink = links[0]
  const url = firstLink ? asString(firstLink.url) : null
  const score = typeof fm.match_score === "number" ? fm.match_score : null
  return {
    key,
    slug,
    title,
    startsAt,
    endsAt: asString(fm.ends_at),
    tz,
    status,
    location: asString(fm.location),
    url,
    topics: asArray(fm.topics),
    tags: asArray(fm.tags),
    matchScore: score,
    matchedTerms: asArray(fm.matched_terms),
  }
}

export const listSuggestions = async (
  bucket: R2Bucket,
): Promise<ReadonlyArray<Suggestion>> => {
  const objects = await listUnder(bucket, SUGGESTED_PREFIX)
  const out: Array<Suggestion> = []
  // Bounded fetch — don't fan out to thousands. R2 list is already sorted desc.
  for (const obj of objects.slice(0, 200)) {
    const got = await bucket.get(obj.key)
    if (!got) continue
    const raw = await got.text()
    const s = decodeSuggestion(obj.key, raw)
    if (s) out.push(s)
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return out
}

const findSuggestionByslug = async (
  bucket: R2Bucket,
  slug: string,
): Promise<Suggestion | null> => {
  if (!SAFE_KEY_RE.test(slug)) return null
  const objects = await listUnder(bucket, SUGGESTED_PREFIX)
  for (const obj of objects) {
    if (!obj.key.endsWith(`--${slug}.md`)) continue
    const got = await bucket.get(obj.key)
    if (!got) return null
    const raw = await got.text()
    return decodeSuggestion(obj.key, raw)
  }
  return null
}

const findEverywhere = async (
  bucket: R2Bucket,
  slug: string,
): Promise<Suggestion | null> => {
  if (!SAFE_KEY_RE.test(slug)) return null
  const inSuggested = await findSuggestionByslug(bucket, slug)
  if (inSuggested) return inSuggested
  // Already-promoted? Look directly under calendar/.
  const objects = await listUnder(bucket, CONFIRMED_PREFIX)
  for (const obj of objects) {
    if (obj.key.startsWith(SUGGESTED_PREFIX)) continue
    if (!obj.key.endsWith(`--${slug}.md`)) continue
    const got = await bucket.get(obj.key)
    if (!got) return null
    const raw = await got.text()
    return decodeSuggestion(obj.key, raw)
  }
  return null
}

const datePart = (startsAt: string): string => {
  const m = startsAt.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m && m[1]) return m[1]
  return startsAt.slice(0, 10)
}

const restamp = (
  raw: string,
  status: "confirmed" | "cancelled",
): string => {
  const parsed = matter(raw)
  const data = { ...((parsed.data ?? {}) as Record<string, unknown>) }
  data.status = status
  data.updated_at = new Date().toISOString()
  // Drop content_hash — local daemon will recompute on next index walk. The R2
  // key is still source of truth for sync purposes.
  delete data.content_hash
  return matter.stringify(parsed.content, data)
}

export type DecisionResult = Readonly<{
  ok: boolean
  message: string
  newKey?: string
}>

export const acceptSuggestion = async (
  bucket: R2Bucket,
  slug: string,
): Promise<DecisionResult> => {
  const found = await findEverywhere(bucket, slug)
  if (!found) return { ok: false, message: `not found: ${slug}` }
  if (found.status === "cancelled") {
    return { ok: false, message: "already dismissed; cannot promote" }
  }
  const inSuggested = found.key.startsWith(SUGGESTED_PREFIX)
  if (found.status === "confirmed" && !inSuggested) {
    return { ok: true, message: "already confirmed", newKey: found.key }
  }
  const got = await bucket.get(found.key)
  if (!got) return { ok: false, message: `read failed: ${found.key}` }
  const raw = await got.text()
  const newRaw = restamp(raw, "confirmed")
  const newKey = `${CONFIRMED_PREFIX}${datePart(found.startsAt)}--${found.slug}.md`
  await bucket.put(newKey, newRaw, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  })
  if (newKey !== found.key) {
    await bucket.delete(found.key)
  }
  return { ok: true, message: "accepted", newKey }
}

export const dismissSuggestion = async (
  bucket: R2Bucket,
  slug: string,
): Promise<DecisionResult> => {
  const found = await findEverywhere(bucket, slug)
  if (!found) return { ok: false, message: `not found: ${slug}` }
  if (found.status === "cancelled") {
    return { ok: true, message: "already dismissed", newKey: found.key }
  }
  const got = await bucket.get(found.key)
  if (!got) return { ok: false, message: `read failed: ${found.key}` }
  const raw = await got.text()
  const newRaw = restamp(raw, "cancelled")
  await bucket.put(found.key, newRaw, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  })
  return { ok: true, message: "dismissed", newKey: found.key }
}
