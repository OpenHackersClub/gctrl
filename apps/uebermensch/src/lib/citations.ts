export type WikiLink = {
  readonly raw: string
  readonly target: string
  readonly display: string | null
  readonly offset: number
}

const LINK_RE = /\[\[([^\]]+)\]\]/g

export const extractLinks = (markdown: string): ReadonlyArray<WikiLink> => {
  const out: Array<WikiLink> = []
  for (const m of markdown.matchAll(LINK_RE)) {
    const inner = m[1] ?? ""
    const pipeIdx = inner.indexOf("|")
    const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim()
    const display = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : null
    out.push({ raw: m[0], target, display, offset: m.index ?? 0 })
  }
  return out
}

export const isTypedPrefix = (target: string): boolean =>
  target.includes(":") || target.includes("/") || target.includes("\\")

const splitSentences = (markdown: string): ReadonlyArray<string> => {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
  return stripped.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
}

const hasLink = (s: string): boolean => /\[\[[^\]]+\]\]/.test(s)

export const claimSentences = (markdown: string): number => splitSentences(markdown).length

export const citedSentences = (markdown: string): number =>
  splitSentences(markdown).filter(hasLink).length

// ---- Citation Mode v1 helpers ----

/**
 * Strip code fences (``` ... ```) and inline code spans (` ... `) from a
 * markdown string, preserving character offsets of the surrounding text by
 * replacing each removed span with a run of spaces of the same length.
 * This lets downstream regexes compute correct character offsets.
 */
const stripCode = (markdown: string): string => {
  // Replace fenced code blocks first (multi-line)
  let out = markdown.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
  // Then inline code spans
  out = out.replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
  return out
}

const NUMERIC_MARKER_RE = /\[(\d+)\]/g

/**
 * Extract all `[n]` citation markers from `md`, skipping those that appear
 * inside code fences (``` ``` ```) or inline code spans.
 * Returns the integer values in document order — duplicates are preserved.
 */
export const extractCitationMarkers = (md: string): ReadonlyArray<number> => {
  const clean = stripCode(md)
  const out: Array<number> = []
  for (const m of clean.matchAll(NUMERIC_MARKER_RE)) {
    out.push(Number(m[1]))
  }
  return out
}

/**
 * Verify that the set of `n` values in `refs` equals `{1, 2, ..., len(refs)}`
 * — 1-based, contiguous, no gaps, no duplicates (R7).
 */
export const verifyReferenceSequence = (
  refs: ReadonlyArray<{ readonly n: number }>,
): { ok: true } | { ok: false; reason: string } => {
  const len = refs.length
  if (len === 0) return { ok: true }
  const seen = new Set<number>()
  for (const ref of refs) {
    if (seen.has(ref.n)) {
      return { ok: false, reason: `duplicate n=${ref.n} in references[]` }
    }
    if (ref.n < 1 || ref.n > len) {
      return {
        ok: false,
        reason: `n=${ref.n} out of range 1..${len} (len=${len})`,
      }
    }
    seen.add(ref.n)
  }
  // All values accounted for — because all are in range and no dups, the set
  // must equal {1..len}.
  return { ok: true }
}

/**
 * Cross-check `[n]` markers in body against `references[]` entries.
 * Implements R4 (every [n] has a matching ref; no duplicate n in refs) and
 * R5 (every ref is cited at least once).
 */
export const crossCheckMarkersAndReferences = (
  markers: ReadonlyArray<number>,
  refs: ReadonlyArray<{ readonly n: number }>,
): { ok: true } | { ok: false; missing: number[]; orphans: number[]; duplicates: number[] } => {
  // Build ref map — detect duplicate n values
  const refMap = new Map<number, number>() // n → count
  for (const ref of refs) {
    refMap.set(ref.n, (refMap.get(ref.n) ?? 0) + 1)
  }
  const duplicates = [...refMap.entries()].filter(([, count]) => count > 1).map(([n]) => n)

  // For each marker, check it has a ref entry
  const markerSet = new Set(markers)
  const missing = [...markerSet].filter((n) => !refMap.has(n))

  // For each ref, check it is cited at least once
  const refNs = new Set(refs.map((r) => r.n))
  const orphans = [...refNs].filter((n) => !markerSet.has(n))

  if (duplicates.length === 0 && missing.length === 0 && orphans.length === 0) {
    return { ok: true }
  }
  return { ok: false, missing, orphans, duplicates }
}
