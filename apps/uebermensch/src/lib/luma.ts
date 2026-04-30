// Luma events fetcher (specs/events.md).
//
// Strategy: extract schema.org `Event` entries from JSON-LD <script> blocks.
// Luma's city pages embed both a per-event JSON-LD block and a richer Next.js
// hydration payload; JSON-LD is the documented public format and is what we
// rely on. The hydration payload is best-effort fallback.
//
// All HTTP I/O is funneled through a single `fetch` parameter so tests can
// supply HTML directly without going to the network.

import { Effect, Schema } from "effect"

const DEFAULT_USER_AGENT = "uebermensch/0.1 (+https://github.com/anthropics/claude-code)"

export class LumaError extends Schema.TaggedError<LumaError>()("LumaError", {
  message: Schema.String,
  url: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  kind: Schema.Literal("invalid_input", "fetch_failed", "http_error"),
}) {}

export type RawEvent = {
  readonly externalId: string
  readonly title: string
  readonly description: string | null
  readonly url: string
  readonly startsAt: string
  readonly endsAt: string | null
  readonly tz: string | null
  readonly location: string | null
  readonly tags: ReadonlyArray<string>
}

export const lumaCityUrl = (city: string): Effect.Effect<string, LumaError> => {
  const slug = city.trim().toLowerCase()
  if (slug.length === 0) {
    return Effect.fail(
      new LumaError({ message: "city is empty", kind: "invalid_input" }),
    )
  }
  return Effect.succeed(`https://lu.ma/${encodeURIComponent(slug)}`)
}

const JSON_LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

const tryParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const flatten = (input: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (input === null || input === undefined) return []
  if (Array.isArray(input)) return input.flatMap(flatten)
  if (typeof input !== "object") return []
  const obj = input as Record<string, unknown>
  // Unwrap @graph / itemListElement shapes that wrap multiple Events.
  if (Array.isArray(obj["@graph"])) return flatten(obj["@graph"])
  if (Array.isArray(obj.itemListElement)) {
    // ItemList entries can be `{ item: { ... Event ... } }` or the Event directly.
    const items = (obj.itemListElement as ReadonlyArray<unknown>).map((entry) => {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>
        if (e.item && typeof e.item === "object") return e.item as Record<string, unknown>
      }
      return entry
    })
    return flatten(items)
  }
  return [obj]
}

const isEventShape = (obj: Record<string, unknown>): boolean => {
  const t = obj["@type"]
  if (typeof t === "string") return t === "Event" || t.endsWith("Event")
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.endsWith("Event"))
  return false
}

const stringField = (obj: Record<string, unknown>, key: string): string | null => {
  const v = obj[key]
  if (typeof v === "string" && v.trim().length > 0) return v.trim()
  return null
}

// schema.org `location` can be a string, a Place, an array of Places.
const extractLocation = (obj: Record<string, unknown>): string | null => {
  const v = obj.location
  if (!v) return null
  if (typeof v === "string") return v.trim()
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = extractLocation({ location: item } as Record<string, unknown>)
      if (s) return s
    }
    return null
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    const name = stringField(o, "name")
    const addressRaw = o.address
    let address: string | null = null
    if (typeof addressRaw === "string") {
      address = addressRaw.trim()
    } else if (addressRaw && typeof addressRaw === "object") {
      const a = addressRaw as Record<string, unknown>
      const parts = [
        stringField(a, "streetAddress"),
        stringField(a, "addressLocality"),
        stringField(a, "addressRegion"),
        stringField(a, "addressCountry"),
      ].filter((p): p is string => p !== null)
      address = parts.length > 0 ? parts.join(", ") : null
    }
    return [name, address].filter((s): s is string => s !== null).join(" — ") || null
  }
  return null
}

const extractTzOffset = (iso: string): string | null => {
  const m = iso.match(/([+-]\d{2}):?(\d{2})$/)
  if (!m) return null
  return `UTC${m[1]}:${m[2]}`
}

// Stable external_id: prefer the URL (canonical Luma event page),
// fall back to a hash-y derivation from name + start.
const externalIdOf = (url: string | null, title: string, startsAt: string): string => {
  if (url) {
    const m = url.match(/lu\.ma\/([A-Za-z0-9_-]+)/)
    if (m) return `luma:${m[1]}`
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `luma:${slug}-${startsAt.slice(0, 10)}`
}

const decodeEvent = (obj: Record<string, unknown>): RawEvent | null => {
  const title = stringField(obj, "name")
  const startsAt = stringField(obj, "startDate")
  if (!title || !startsAt) return null
  const url = stringField(obj, "url")
  const description = stringField(obj, "description")
  const endsAt = stringField(obj, "endDate")
  const location = extractLocation(obj)
  const tz = extractTzOffset(startsAt)
  const keywordsRaw = obj.keywords
  let tags: ReadonlyArray<string> = []
  if (typeof keywordsRaw === "string") {
    tags = keywordsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  } else if (Array.isArray(keywordsRaw)) {
    tags = keywordsRaw.filter((x): x is string => typeof x === "string")
  }
  return {
    externalId: externalIdOf(url, title, startsAt),
    title,
    description,
    url: url ?? "",
    startsAt,
    endsAt,
    tz,
    location,
    tags,
  }
}

// Pure: given a Luma HTML page, return all distinct Event entries it embeds.
export const parseLumaPage = (html: string): ReadonlyArray<RawEvent> => {
  const seen = new Map<string, RawEvent>()
  const re = new RegExp(JSON_LD_RE.source, JSON_LD_RE.flags)
  for (;;) {
    const m = re.exec(html)
    if (m === null) break
    const captured = m[1]
    if (captured === undefined) continue
    const parsed = tryParse(captured.trim())
    if (!parsed) continue
    for (const candidate of flatten(parsed)) {
      if (!isEventShape(candidate)) continue
      const ev = decodeEvent(candidate)
      if (!ev) continue
      if (!seen.has(ev.externalId)) seen.set(ev.externalId, ev)
    }
  }
  return [...seen.values()]
}

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export type FetchLumaOpts = {
  readonly fetch?: FetchFn
  readonly userAgent?: string
}

export const fetchLumaEvents = (
  cityUrl: string,
  opts: FetchLumaOpts = {},
): Effect.Effect<ReadonlyArray<RawEvent>, LumaError> =>
  Effect.gen(function* () {
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchFn | undefined)
    if (!f) {
      return yield* Effect.fail(
        new LumaError({
          message: "no fetch implementation available",
          url: cityUrl,
          kind: "fetch_failed",
        }),
      )
    }
    const res = yield* Effect.tryPromise({
      try: () =>
        f(cityUrl, {
          headers: {
            "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT,
            accept: "text/html",
          },
        }),
      catch: (e) =>
        new LumaError({
          message: `luma fetch failed: ${String(e)}`,
          url: cityUrl,
          kind: "fetch_failed",
        }),
    })
    if (!res.ok) {
      return yield* Effect.fail(
        new LumaError({
          message: `luma fetch ${cityUrl} → ${res.status}`,
          url: cityUrl,
          status: res.status,
          kind: "http_error",
        }),
      )
    }
    const html = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        new LumaError({
          message: `luma read body failed: ${String(e)}`,
          url: cityUrl,
          kind: "fetch_failed",
        }),
    })
    return parseLumaPage(html)
  })
