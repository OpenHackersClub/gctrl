import { useEffect, useState } from "react"
import type { AcceptanceRollup } from "../types"
import { api } from "../api/client"

interface Props {
  issueId: string
  /** Optional rollup passed in from the parent. Skips the fetch when present. */
  rollup?: AcceptanceRollup
}

export function AcceptanceBadge({ issueId, rollup: passed }: Props) {
  const [rollup, setRollup] = useState<AcceptanceRollup | undefined>(passed)

  useEffect(() => {
    if (passed) return
    let alive = true
    api.issues
      .acceptance(issueId)
      .then((r) => {
        if (alive) setRollup(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [issueId, passed])

  if (!rollup || rollup.total === 0) return null

  const allPassed = rollup.passed === rollup.total
  const anyFailed = rollup.failed > 0
  const tone = anyFailed
    ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
    : allPassed
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : "bg-amber-500/10 text-amber-300 border-amber-500/20"

  return (
    <span
      data-testid={`acceptance-badge-${issueId}`}
      title={
        `Acceptance: ${rollup.passed}/${rollup.total} passed` +
        (rollup.failed ? ` · ${rollup.failed} failed` : "") +
        (rollup.pending ? ` · ${rollup.pending} pending` : "")
      }
      className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 border ${tone}`}
    >
      <span className="opacity-60">AC</span>
      {rollup.passed}/{rollup.total}
      {allPassed ? " ✓" : anyFailed ? " ✗" : ""}
    </span>
  )
}
