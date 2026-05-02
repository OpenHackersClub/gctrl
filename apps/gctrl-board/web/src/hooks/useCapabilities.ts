/**
 * `useCapabilities` — fetch and cache the kernel's `/api/comm/capabilities`
 * snapshot, with degraded-only polling.
 *
 * - On mount: fetch once.
 * - If the response says `automation_granted: false`, re-fetch every 10s
 *   until the user grants Automation in System Settings (and the response
 *   flips to `true`). Stop polling on grant.
 * - If `automation_granted` is granted (true) or unknown (null/undefined),
 *   never poll. Apple Events grants are sticky once given, and the
 *   "unknown" state shouldn't itself drive UI thrash.
 *
 * Manual `refresh()` is exposed for the "I just granted it" affordance —
 * the inbox renders a tiny Refresh button next to the disabled tooltip.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"
import type { CommCapabilities } from "../types"

const DEGRADED_POLL_MS = 10_000

interface UseCapabilitiesResult {
  capabilities: CommCapabilities | null
  loading: boolean
  /** Force-refetch — used by a manual "Refresh" affordance after the user
   *  has just granted Automation. */
  refresh: () => void
}

export function useCapabilities(): UseCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<CommCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false

    const fetchOnce = async () => {
      try {
        const caps = await api.comm.capabilities()
        if (cancelled) return
        setCapabilities(caps)
      } catch {
        // Treat fetch failure as "kernel offline" — leave caps null so the
        // UI hides the Focus button.
        if (!cancelled) setCapabilities(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchOnce()

    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    // Schedule the next degraded poll only if the most recent snapshot says
    // we're degraded. Any other state (granted, unknown, null) clears the
    // timer.
    const degraded = capabilities?.automation_granted === false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (degraded) {
      timerRef.current = setTimeout(() => {
        setTick((t) => t + 1)
      }, DEGRADED_POLL_MS)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [capabilities])

  return { capabilities, loading, refresh }
}
