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
