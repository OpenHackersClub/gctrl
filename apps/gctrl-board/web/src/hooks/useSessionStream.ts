// Live session-event stream hook.
//
// Wraps the browser `EventSource` against the kernel SSE endpoints
// specified in `vault/specs/architecture/apps/gctrl-analytics.md` §5:
//   GET /api/sessions/stream            — every event
//   GET /api/sessions/{id}/stream       — events for one session
//
// EventSource transparently reconnects with the last received `id` as
// `Last-Event-ID`, so the kernel can replay buffered events or emit
// `replay_gap`. Consumers typically refetch state on `replay_gap` and
// resume tailing.

import { useEffect, useRef } from "react"

export type StreamHandler = (
  event: SessionStreamEvent,
  raw: MessageEvent,
) => void

export type GapHandler = () => void

export type SessionStreamEvent =
  | {
      type: "session_started"
      session_id: string
      agent_name: string
      started_at: string
    }
  | {
      type: "session_span"
      session_id: string
      span_id: string
      parent_span_id: string | null
      span_type: string
      operation: string
      model: string | null
      cost_usd: number
      duration_ms: number
      status: string
      ts: string
    }
  | {
      type: "session_status_changed"
      session_id: string
      status: string
      ts: string
    }
  | {
      type: "session_ended"
      session_id: string
      status: string
      ended_at: string
    }

const NAMED_EVENTS = [
  "session.started",
  "session.span",
  "session.status_changed",
  "session.ended",
] as const

interface Options {
  /** Per-session filter — if set, opens `/api/sessions/{id}/stream`. */
  sessionId?: string | null
  /** Called on every parsed event. */
  onEvent?: StreamHandler
  /** Called when the kernel signals it dropped events from the replay
   *  ring. Consumers should refetch state from non-stream routes. */
  onReplayGap?: GapHandler
  /** Disable the connection (e.g. for tabs that don't need live data). */
  disabled?: boolean
}

/** Open and manage one EventSource for the lifetime of the component. */
export function useSessionStream({
  sessionId,
  onEvent,
  onReplayGap,
  disabled,
}: Options) {
  // Stash callbacks in a ref so the EventSource isn't torn down every
  // time the parent re-renders with a new closure.
  const onEventRef = useRef(onEvent)
  const onGapRef = useRef(onReplayGap)
  onEventRef.current = onEvent
  onGapRef.current = onReplayGap

  useEffect(() => {
    if (disabled) return
    const url = sessionId
      ? `/api/sessions/${sessionId}/stream`
      : `/api/sessions/stream`
    const es = new EventSource(url)

    const handleNamed = (raw: MessageEvent) => {
      const cb = onEventRef.current
      if (!cb) return
      try {
        const data = JSON.parse(raw.data) as SessionStreamEvent
        cb(data, raw)
      } catch {
        // Malformed payload — ignore. The kernel always serializes
        // valid JSON; this would only fire on a proxy injecting noise.
      }
    }

    for (const name of NAMED_EVENTS) {
      es.addEventListener(name, handleNamed)
    }
    es.addEventListener("replay_gap", () => {
      onGapRef.current?.()
    })

    return () => {
      es.close()
    }
  }, [sessionId, disabled])
}
