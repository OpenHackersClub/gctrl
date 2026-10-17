import { describe, expect, it } from "vitest"
import { buildRecommendations, removeCandidates } from "./disk-recommendations"

const day = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 9, 1)

describe("disk cleanup recommendations", () => {
  it("groups old outputs and older caches without recommending the same path twice", () => {
    const recommendations = buildRecommendations([
      { path: "/work/a/target", bytes: 2_000_000_000, kind: "Rust build", modified_at_ms: now - 45 * day },
      { path: "/work/b/dist", bytes: 500_000_000, kind: "Distribution build", modified_at_ms: now - 31 * day },
      { path: "/work/c/.turbo", bytes: 200_000_000, kind: "Turborepo cache", modified_at_ms: now - 3 * day },
      { path: "/work/d/node_modules/.cache", bytes: 100_000_000, kind: "Package build cache", modified_at_ms: now - 2 * day },
      { path: "/work/e/target", bytes: 3_000_000_000, kind: "Rust build", modified_at_ms: now - day },
    ], now)

    expect(recommendations.map((item) => item.id)).toEqual(["old", "caches"])
    expect(recommendations[0].candidates.map((item) => item.path)).toEqual(["/work/a/target", "/work/b/dist"])
    expect(recommendations[0].bytes).toBe(2_500_000_000)
    expect(recommendations[1].candidates.map((item) => item.path)).toEqual(["/work/c/.turbo", "/work/d/node_modules/.cache"])
  })

  it("does not recommend recent, empty, or undated outputs for bulk removal", () => {
    expect(buildRecommendations([
      { path: "/work/a/target", bytes: 100, kind: "Rust build", modified_at_ms: now - day },
      { path: "/work/b/.turbo", bytes: 100, kind: "Turborepo cache", modified_at_ms: now },
      { path: "/work/c/target", bytes: 0, kind: "Rust build", modified_at_ms: now - 60 * day },
      { path: "/work/d/dist", bytes: 100, kind: "Distribution build", modified_at_ms: null },
    ], now)).toEqual([])
  })

  it("offers the largest remaining outputs as a review-required group", () => {
    const recommendations = buildRecommendations([
      { path: "/a/target", bytes: 2_000_000_000, kind: "Rust build", modified_at_ms: now - 8 * day },
      { path: "/b/dist", bytes: 500_000_000, kind: "Distribution build", modified_at_ms: now - 8 * day },
      { path: "/c/build", bytes: 10_000_000, kind: "Build output", modified_at_ms: now - day },
      { path: "/active/target", bytes: 4_000_000_000, kind: "Rust build", modified_at_ms: now - day },
    ], now)
    expect(recommendations.map((item) => item.id)).toEqual(["largest"])
    expect(recommendations[0].candidates.map((item) => item.path)).toEqual(["/a/target", "/b/dist"])
  })

  it("continues after an item fails and reports each outcome", async () => {
    const calls: string[] = []
    const progress: number[] = []
    const result = await removeCandidates(["/a/target", "/b/dist", "/c/.turbo"], async (path) => {
      calls.push(path)
      if (path === "/b/dist") throw new Error("still in use")
    }, (completed) => progress.push(completed))
    expect(calls).toEqual(["/a/target", "/b/dist", "/c/.turbo"])
    expect(progress).toEqual([1, 2, 3])
    expect(result).toEqual({ removed: 2, failed: [{ path: "/b/dist", reason: "still in use" }] })
  })
})
