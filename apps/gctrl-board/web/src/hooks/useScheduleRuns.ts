import { useEffect, useState } from "react"
import { api } from "@/api/client"
import type { ScheduleRun } from "@/types"

interface UseScheduleRunsParams {
  /** RFC3339 lower bound on `started_at`. */
  since?: string
  status?: string
  limit?: number
}

/** Per-routine run history for the sparkline + detail-drawer Runs tab.
 *
 *  Polled, not streamed — spec § 7.5 defers SSE to the backlog. The
 *  caller (sparkline / drawer) decides limit; the kernel clamps at
 *  500 anyway.
 */
export function useScheduleRuns(
  scheduleNameOrId: string | null,
  params?: UseScheduleRunsParams,
): {
  runs: ScheduleRun[]
  loading: boolean
  error: string | null
} {
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stringify params so the dep array is stable. Two callers with
  // identical filters won't trigger refetches.
  const paramsKey = JSON.stringify(params ?? {})

  useEffect(() => {
    if (scheduleNameOrId == null) {
      setRuns([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.schedules
      .runs(scheduleNameOrId, params)
      .then((res) => {
        if (cancelled) return
        setRuns(res.runs)
        setError(null)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleNameOrId, paramsKey])

  return { runs, loading, error }
}
