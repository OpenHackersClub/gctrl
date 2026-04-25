import { useCallback, useEffect, useState } from "react"
import { api } from "../api/client"
import type { GanttIssue, GanttView, IssueStatus } from "../types"

/**
 * Gantt data hook. Mirrors `useIssues` patterns:
 *  - Optimistic local updates on `updateSchedule` / `moveStatus`.
 *  - On failure, caller reverts (we throw; parent toasts).
 *
 * Naming borrowed from frappe/gantt's `on_date_change(task, start, end)` —
 * our `updateSchedule(issueId, { start_date, due_date })` is the equivalent
 * but accepts partial patches (either field may be null to clear).
 */
export function useGantt(projectId: string | null) {
  const [data, setData] = useState<GanttView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setData(null)
      return
    }
    try {
      setLoading(true)
      const view = await api.gantt.project(projectId)
      setData(view)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load gantt")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  const patchLocal = useCallback((issueId: string, patch: Partial<GanttIssue>) => {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        issues: prev.issues.map((i) =>
          i.id === issueId ? { ...i, ...patch } : i
        ),
      }
    })
  }, [])

  const updateSchedule = useCallback(
    async (
      issueId: string,
      patch: { start_date?: string | null; due_date?: string | null },
    ) => {
      const prev = data?.issues.find((i) => i.id === issueId)
      patchLocal(issueId, patch as Partial<GanttIssue>)
      try {
        await api.issues.schedule(issueId, patch)
      } catch (e) {
        if (prev) {
          patchLocal(issueId, {
            start_date: prev.start_date,
            due_date: prev.due_date,
          })
        }
        throw e
      }
    },
    [data, patchLocal],
  )

  const moveStatus = useCallback(
    async (issueId: string, newStatus: IssueStatus) => {
      const prev = data?.issues.find((i) => i.id === issueId)
      patchLocal(issueId, { status: newStatus })
      try {
        await api.issues.move(issueId, newStatus)
      } catch (e) {
        if (prev) patchLocal(issueId, { status: prev.status })
        throw e
      }
    },
    [data, patchLocal],
  )

  return { data, loading, error, refresh, updateSchedule, moveStatus }
}
