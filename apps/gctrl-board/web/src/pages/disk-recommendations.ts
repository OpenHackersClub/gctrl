import type { DiskCandidate } from "../api/client"

export interface DiskRecommendation {
  id: string
  title: string
  reason: string
  candidates: DiskCandidate[]
  bytes: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_GROUP_SIZE = 20
const LARGE_OUTPUT_BYTES = 100 * 1024 * 1024
const CACHE_KINDS = new Set(["Turborepo cache", "Gradle cache", "Package build cache"])

export function buildRecommendations(candidates: DiskCandidate[], now: number): DiskRecommendation[] {
  const ordered = candidates
    .filter((candidate) => candidate.bytes > 0 && candidate.modified_at_ms !== null)
    .sort((a, b) => b.bytes - a.bytes)
  const old = ordered.filter((candidate) => candidate.modified_at_ms! <= now - 30 * DAY_MS).slice(0, MAX_GROUP_SIZE)
  const oldGroup = old.length >= 2 ? old : []
  const oldPaths = new Set(oldGroup.map((candidate) => candidate.path))
  const caches = ordered.filter((candidate) =>
    !oldPaths.has(candidate.path)
    && CACHE_KINDS.has(candidate.kind)
    && candidate.modified_at_ms! <= now - DAY_MS,
  ).slice(0, MAX_GROUP_SIZE)
  const cacheGroup = caches.length >= 2 ? caches : []
  const usedPaths = new Set([...oldGroup, ...cacheGroup].map((candidate) => candidate.path))
  const largest = ordered.filter((candidate) =>
    !usedPaths.has(candidate.path)
    && !CACHE_KINDS.has(candidate.kind)
    && candidate.bytes >= LARGE_OUTPUT_BYTES
    && candidate.modified_at_ms! <= now - 7 * DAY_MS,
  ).slice(0, 5)
  const recommendations: DiskRecommendation[] = []
  if (oldGroup.length > 0) recommendations.push({
    id: "old",
    title: "Older build outputs",
    reason: "The newest file timestamp in each output is at least 30 days old. Builds can recreate them.",
    candidates: oldGroup,
    bytes: oldGroup.reduce((sum, candidate) => sum + candidate.bytes, 0),
  })
  if (cacheGroup.length > 0) recommendations.push({
    id: "caches",
    title: "Build caches",
    reason: "The newest file timestamp in each cache is at least a day old. Tools can recreate them.",
    candidates: cacheGroup,
    bytes: cacheGroup.reduce((sum, candidate) => sum + candidate.bytes, 0),
  })
  if (largest.length >= 2) recommendations.push({
    id: "largest",
    title: "Largest build outputs",
    reason: "These are at least seven days old and can be rebuilt. Review their paths; removing an active output can interrupt a build.",
    candidates: largest,
    bytes: largest.reduce((sum, candidate) => sum + candidate.bytes, 0),
  })
  return recommendations
}

export async function removeCandidates(paths: string[], remove: (path: string) => Promise<unknown>, onProgress?: (completed: number) => void): Promise<{ removed: number; failed: { path: string; reason: string }[] }> {
  let removed = 0
  const failed: { path: string; reason: string }[] = []
  for (const [index, path] of paths.entries()) {
    try {
      await remove(path)
      removed++
    } catch (cause) {
      failed.push({ path, reason: cause instanceof Error ? cause.message : "Removal failed" })
    }
    onProgress?.(index + 1)
  }
  return { removed, failed }
}
