import { useCallback, useEffect, useState } from "react"
import { api } from "../api/client"
import type { AgentRunsResponse, InboxMessage } from "../types"

/** Poll interval for `/api/agents` (agent-panel.md § Board page). */
export const AGENTS_POLL_MS = 5_000

interface UseAgentsResult {
  data: AgentRunsResponse | null
  /** Pending actionable inbox messages — the Needs you join input. */
  messages: InboxMessage[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Polls the kernel's run index plus the open inbox requests. The last good
 * response stays on screen when a poll fails, so a kernel restart does not
 * blank the board.
 */
export function useAgents(filters: { includeHeadless: boolean; includeStale: boolean }): UseAgentsResult {
  const { includeHeadless, includeStale } = filters
  const [data, setData] = useState<AgentRunsResponse | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  const refresh = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      Promise.all([
        api.agents.list({ includeHeadless, includeStale }),
        // The inbox is optional context; its absence only empties Needs you.
        api.inbox
          .messages({ status: "pending", requires_action: true, limit: 500 })
          .catch((): InboxMessage[] => []),
      ])
        .then(([runs, pending]) => {
          if (cancelled) return
          setData(runs)
          setMessages(pending)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    load()
    const interval = setInterval(load, AGENTS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // `revision` forces an immediate reload after an open action.
  }, [includeHeadless, includeStale, revision])

  return { data, messages, loading, error, refresh }
}
