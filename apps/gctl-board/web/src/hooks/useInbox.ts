import { useState, useEffect, useCallback } from "react"
import type { InboxMessage, InboxThread, InboxStats } from "../types"
import { api } from "../api/client"

interface UseInboxFilters {
  status?: string
  urgency?: string
  kind?: string
}

interface UseInboxResult {
  messages: InboxMessage[]
  threads: InboxThread[]
  stats: InboxStats | null
  loading: boolean
  refresh: () => void
  createAction: (messageId: string, actionType: string, reason?: string) => Promise<void>
  batchAction: (messageIds: string[], actionType: string, reason?: string) => Promise<void>
}

export function useInbox(filters?: UseInboxFilters): UseInboxResult {
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [stats, setStats] = useState<InboxStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)

  const refresh = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const params: Record<string, string> = {}
    if (filters?.status) params.status = filters.status
    if (filters?.urgency) params.urgency = filters.urgency
    if (filters?.kind) params.kind = filters.kind

    Promise.all([
      api.inbox.messages(params),
      api.inbox.threads(params),
      api.inbox.stats(),
    ])
      .then(([msgs, thrds, st]) => {
        if (cancelled) return
        setMessages(msgs)
        setThreads(thrds)
        setStats(st)
      })
      .catch(() => {
        // errors surfaced via empty state
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [filters?.status, filters?.urgency, filters?.kind, revision])

  const createAction = useCallback(
    async (messageId: string, actionType: string, reason?: string) => {
      await api.inbox.createAction({ message_id: messageId, action_type: actionType, reason })
      refresh()
    },
    [refresh]
  )

  const batchAction = useCallback(
    async (messageIds: string[], actionType: string, reason?: string) => {
      await api.inbox.batchAction({ message_ids: messageIds, action_type: actionType, reason })
      refresh()
    },
    [refresh]
  )

  return { messages, threads, stats, loading, refresh, createAction, batchAction }
}
