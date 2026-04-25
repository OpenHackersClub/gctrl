import { useCallback, useEffect, useState, type ReactNode } from "react"
import { api } from "../api/client"
import type {
  AnalyticsOverview,
  CostAnalytics,
  SessionSummary,
  TraceTreeNode,
  TraceTreeResponse,
  LatencyAnalytics,
  SpanAnalytics,
  ScoreSummary,
  AlertRule,
} from "../types"
import type { Route } from "../hooks/useRoute"
import { useSessionStream } from "../hooks/useSessionStream"

interface AnalyticsPageProps {
  route: Extract<Route, { page: "analytics" }>
  navigate: (path: string) => void
}

export function AnalyticsPage({ route, navigate }: AnalyticsPageProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
      {/* Tab bar */}
      <div className="h-10 border-b border-zinc-800/80 flex items-center gap-1 px-4 bg-zinc-950/90">
        <TabButton
          label="Overview"
          active={route.tab === "overview"}
          onClick={() => navigate("/analytics/overview")}
        />
        <TabButton
          label="Sessions"
          active={route.tab === "sessions"}
          onClick={() => navigate("/analytics/sessions")}
        />
        <TabButton
          label="Usage"
          active={route.tab === "usage"}
          onClick={() => navigate("/analytics/usage")}
        />
        <TabButton
          label="Evals"
          active={route.tab === "evals"}
          onClick={() => navigate("/analytics/evals")}
        />
        <div className="flex-1" />
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 tracking-wide"
          title="Live updates stream from /api/sessions/stream — no polling."
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          live
        </span>
      </div>

      {/* Tab body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {route.tab === "overview" && <OverviewTab />}
        {route.tab === "sessions" && (
          <SessionsTab
            selectedSessionId={route.sessionId}
            onSelectSession={(id) =>
              navigate(id ? `/analytics/sessions/${id}` : "/analytics/sessions")
            }
          />
        )}
        {route.tab === "usage" && <UsageTab />}
        {route.tab === "evals" && <EvalsTab />}
      </div>
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 h-8 text-[12px] font-display tracking-wide uppercase transition-colors cursor-pointer
        ${
          active
            ? "text-emerald-400 border-b-2 border-emerald-400"
            : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
        }`}
    >
      {label}
    </button>
  )
}

// ───────────────────────── Overview ─────────────────────────

function OverviewTab() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [cost, setCost] = useState<CostAnalytics | null>(null)
  const [liveCount, setLiveCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [o, c, live] = await Promise.all([
        api.analytics.overview(),
        api.analytics.cost(),
        // Kernel's /api/analytics rollup has no active_sessions field;
        // count from sessions.list?status=active instead.
        api.sessions.list({ status: "active", limit: 200 }),
      ])
      setOverview(o)
      setCost(c)
      setLiveCount(live.length)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Initial fetch on mount.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Live updates: stream session lifecycle events, adjust the live
  // count, and refetch the cost/total aggregates on session end.
  useSessionStream({
    onEvent: (ev) => {
      if (ev.type === "session_started") {
        setLiveCount((n) => (n ?? 0) + 1)
      } else if (ev.type === "session_ended") {
        setLiveCount((n) => Math.max(0, (n ?? 0) - 1))
        // Aggregates change when a session finishes; pull fresh totals.
        // Cost-by-model rollup also reflects the just-ended session.
        refresh()
      }
    },
    onReplayGap: refresh,
  })

  if (error) {
    return (
      <div className="p-8 text-rose-400 font-mono text-sm">
        Failed to load overview: {error}
        <div className="mt-2 text-zinc-500">
          Is the kernel running on :4318?
        </div>
      </div>
    )
  }

  if (!overview) {
    return <div className="p-8 text-zinc-500 font-mono text-sm">Loading…</div>
  }

  return (
    <div className="p-6 space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <Kpi label="Live sessions" value={liveCount ?? "—"} accent />
        <Kpi label="Total sessions" value={overview.total_sessions} />
        <Kpi label="Spans" value={overview.total_spans.toLocaleString()} />
        <Kpi
          label="Total cost"
          value={`$${overview.total_cost_usd.toFixed(4)}`}
        />
      </div>

      {/* Cost tables */}
      {cost && (
        <div className="grid grid-cols-2 gap-4">
          <CostTable
            title="Cost by model"
            rows={cost.by_model.map((m) => ({
              key: m.model,
              primary: m.model,
              cost: m.cost,
              count: m.calls,
              countLabel: "calls",
            }))}
          />
          <CostTable
            title="Cost by agent"
            rows={cost.by_agent.map((a) => ({
              key: a.agent,
              primary: a.agent,
              cost: a.cost,
              count: a.sessions,
              countLabel: "sessions",
            }))}
          />
        </div>
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string
  value: string | number
  accent?: boolean
}) {
  return (
    <div
      className={`border p-4 ${
        accent
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-zinc-800 bg-zinc-900/30"
      }`}
    >
      <div className="text-[11px] font-mono tracking-wider text-zinc-500 uppercase mb-1">
        {label}
      </div>
      <div
        className={`text-2xl font-display font-semibold ${
          accent ? "text-emerald-400" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function CostTable({
  title,
  rows,
}: {
  title: string
  rows: Array<{
    key: string
    primary: string
    cost: number
    count: number
    countLabel: string
  }>
}) {
  return (
    <div className="border border-zinc-800 bg-zinc-900/30">
      <div className="px-4 py-2 border-b border-zinc-800 text-[11px] font-mono tracking-wider text-zinc-400 uppercase">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="p-4 text-sm text-zinc-600 font-mono">No data yet.</div>
      ) : (
        <table className="w-full text-[13px] font-mono">
          <thead>
            <tr className="text-zinc-500 text-[10px] uppercase tracking-wider">
              <th className="text-left font-normal px-4 py-1.5">Name</th>
              <th className="text-right font-normal px-4 py-1.5">Cost</th>
              <th className="text-right font-normal px-4 py-1.5">
                {rows[0].countLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-t border-zinc-800/60 hover:bg-zinc-800/40"
              >
                <td className="px-4 py-1.5 text-zinc-200 truncate max-w-[240px]">
                  {r.primary}
                </td>
                <td className="px-4 py-1.5 text-right text-emerald-400">
                  ${r.cost.toFixed(4)}
                </td>
                <td className="px-4 py-1.5 text-right text-zinc-400">
                  {r.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ───────────────────────── Sessions ─────────────────────────

function SessionsTab({
  selectedSessionId,
  onSelectSession,
}: {
  selectedSessionId: string | null
  onSelectSession: (id: string | null) => void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const list = await api.sessions.list({ limit: 100 })
      setSessions(list)
      setError(null)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  // Initial fetch on mount.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Live updates from the SSE stream:
  //  - `session.started` → prepend a synthetic row, server's full row
  //    will overwrite on the next `session.span` (which carries
  //    agent_name + cost) or on the next manual refresh.
  //  - `session.ended` → mark the row terminal so the live pulse stops.
  //  - On replay_gap or any error in the data path, refetch the list.
  useSessionStream({
    onEvent: (ev) => {
      if (ev.type === "session_started") {
        setSessions((rows) => {
          if (rows.some((r) => r.id === ev.session_id)) return rows
          const placeholder: SessionSummary = {
            id: ev.session_id,
            workspace_id: "default",
            device_id: "local",
            agent_name: ev.agent_name,
            started_at: ev.started_at,
            ended_at: null,
            status: "active",
            total_cost_usd: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
          }
          return [placeholder, ...rows]
        })
      } else if (ev.type === "session_ended") {
        setSessions((rows) =>
          rows.map((r) =>
            r.id === ev.session_id
              ? {
                  ...r,
                  ended_at: ev.ended_at,
                  status:
                    ev.status === "failed"
                      ? "failed"
                      : ev.status === "cancelled"
                        ? "cancelled"
                        : "completed",
                }
              : r,
          ),
        )
      }
    },
    onReplayGap: refresh,
  })

  const selected =
    selectedSessionId != null
      ? sessions.find((s) => s.id === selectedSessionId) ?? null
      : null

  if (error) {
    return (
      <div className="p-8 text-rose-400 font-mono text-sm">
        Failed to load sessions: {error}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {/* List */}
      <div className="flex-1 min-w-0 border-r border-zinc-800 overflow-auto">
        <table className="w-full text-[13px] font-mono">
          <thead className="sticky top-0 bg-zinc-950 z-10">
            <tr className="text-zinc-500 text-[10px] uppercase tracking-wider">
              <th className="text-left font-normal px-4 py-2">Status</th>
              <th className="text-left font-normal px-4 py-2">Agent</th>
              <th className="text-left font-normal px-4 py-2">Started</th>
              <th className="text-right font-normal px-4 py-2">Dur</th>
              <th className="text-right font-normal px-4 py-2">Tokens</th>
              <th className="text-right font-normal px-4 py-2">Cost</th>
              <th className="text-left font-normal px-4 py-2">ID</th>
            </tr>
          </thead>
          <tbody>
            {loading && sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-zinc-600">
                  Loading sessions…
                </td>
              </tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-zinc-600">
                  No sessions yet. Spawn an agent and this table will populate.
                </td>
              </tr>
            )}
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={s.id === selectedSessionId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail */}
      {selected && (
        <SessionDetailPane
          session={selected}
          onClose={() => onSelectSession(null)}
        />
      )}
    </div>
  )
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary
  selected: boolean
  onSelect: () => void
}) {
  const durationMs = session.ended_at
    ? new Date(session.ended_at).getTime() -
      new Date(session.started_at).getTime()
    : Date.now() - new Date(session.started_at).getTime()

  const isLive = session.ended_at === null && session.status === "active"

  return (
    <tr
      onClick={onSelect}
      className={`border-t border-zinc-800/60 cursor-pointer transition-colors ${
        selected ? "bg-emerald-500/5" : "hover:bg-zinc-800/40"
      }`}
    >
      <td className="px-4 py-1.5">
        <StatusBadge status={session.status} live={isLive} />
      </td>
      <td className="px-4 py-1.5 text-zinc-200 truncate max-w-[180px]">
        {session.agent_name || "—"}
      </td>
      <td className="px-4 py-1.5 text-zinc-400 text-[12px]">
        {new Date(session.started_at).toLocaleString()}
      </td>
      <td className="px-4 py-1.5 text-right text-zinc-400 text-[12px]">
        {formatDuration(durationMs)}
      </td>
      <td className="px-4 py-1.5 text-right text-zinc-400 text-[12px]">
        {(
          session.total_input_tokens + session.total_output_tokens
        ).toLocaleString()}
      </td>
      <td className="px-4 py-1.5 text-right text-emerald-400">
        ${session.total_cost_usd.toFixed(4)}
      </td>
      <td className="px-4 py-1.5 text-zinc-600 text-[11px] truncate max-w-[160px]">
        {session.id}
      </td>
    </tr>
  )
}

function StatusBadge({
  status,
  live,
}: {
  status: SessionSummary["status"]
  live: boolean
}) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono uppercase tracking-wider">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        live
      </span>
    )
  }
  const color =
    status === "completed"
      ? "text-zinc-400"
      : status === "failed"
        ? "text-rose-400"
        : status === "cancelled"
          ? "text-amber-400"
          : "text-zinc-500"
  return (
    <span className={`text-[11px] font-mono uppercase tracking-wider ${color}`}>
      {status}
    </span>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function SessionDetailPane({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}) {
  const [tree, setTree] = useState<TraceTreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isLive = session.ended_at === null && session.status === "active"

  const refresh = useCallback(async () => {
    try {
      const t = await api.sessions.tree(session.id)
      setTree(t)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [session.id])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Per-session stream: refetch the trace tree on every span event for
  // this session. The kernel returns the full tree (root + direct
  // children) cheaply, and this guarantees the UI never reorders or
  // drops a child relative to a server-side rebuild.
  useSessionStream({
    sessionId: session.id,
    disabled: !isLive,
    onEvent: (ev) => {
      if (ev.type === "session_span") {
        refresh()
      }
    },
    onReplayGap: refresh,
  })

  return (
    <aside className="w-[540px] min-w-[540px] bg-zinc-950 border-l border-zinc-800 flex flex-col overflow-hidden">
      <header className="h-10 border-b border-zinc-800 flex items-center justify-between px-4">
        <div className="text-[11px] font-mono tracking-wider text-zinc-400 uppercase truncate">
          {session.id}
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 text-lg leading-none cursor-pointer"
          title="Close"
        >
          ×
        </button>
      </header>

      <div className="p-4 space-y-3 border-b border-zinc-800">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] font-mono">
          <DetailField label="Agent" value={session.agent_name || "—"} />
          <DetailField
            label="Status"
            value={<StatusBadge status={session.status} live={isLive} />}
          />
          <DetailField
            label="Started"
            value={new Date(session.started_at).toLocaleString()}
          />
          <DetailField
            label="Ended"
            value={
              session.ended_at
                ? new Date(session.ended_at).toLocaleString()
                : "—"
            }
          />
          <DetailField
            label="Tokens"
            value={`${session.total_input_tokens.toLocaleString()} in / ${session.total_output_tokens.toLocaleString()} out`}
          />
          <DetailField
            label="Cost"
            value={
              <span className="text-emerald-400">
                ${session.total_cost_usd.toFixed(4)}
              </span>
            }
          />
        </div>
      </div>

      <div className="px-4 py-2 border-b border-zinc-800 text-[10px] font-mono tracking-wider text-zinc-500 uppercase">
        Trace
      </div>
      <div className="flex-1 overflow-auto p-3 text-[12px] font-mono">
        {error && <div className="text-rose-400">Error: {error}</div>}
        {!error && !tree && <div className="text-zinc-600">Loading…</div>}
        {tree && (!tree.spans || tree.spans.length === 0) && (
          <div className="text-zinc-600">No spans yet.</div>
        )}
        {tree && tree.spans && tree.spans.length > 0 && (
          <ul className="space-y-1">
            {tree.spans.map((node) => (
              <SpanNode key={node.span_id} node={node} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function DetailField({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">
        {label}
      </div>
      <div className="text-zinc-200 truncate">{value}</div>
    </div>
  )
}

function SpanNode({ node, depth }: { node: TraceTreeNode; depth: number }) {
  const isError = node.status === "error"
  return (
    <li>
      <div
        style={{ paddingLeft: depth * 14 }}
        className={`flex items-center gap-2 py-0.5 ${
          isError ? "text-rose-400" : "text-zinc-300"
        }`}
      >
        <span className="text-zinc-600 text-[10px] uppercase tracking-wider w-14 shrink-0">
          {node.type}
        </span>
        <span className="truncate">
          {node.operation || node.model || node.span_id.slice(0, 8)}
        </span>
        {node.duration_ms !== null && node.duration_ms !== undefined && (
          <span className="text-zinc-600 text-[11px] ml-auto shrink-0">
            {node.duration_ms}ms
          </span>
        )}
        {node.cost_usd !== null &&
          node.cost_usd !== undefined &&
          node.cost_usd > 0 && (
            <span className="text-emerald-500/70 text-[11px] shrink-0">
              ${node.cost_usd.toFixed(4)}
            </span>
          )}
      </div>
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <SpanNode key={c.span_id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

// ───────────────────────── Usage ─────────────────────────

function UsageTab() {
  const [cost, setCost] = useState<CostAnalytics | null>(null)
  const [latency, setLatency] = useState<LatencyAnalytics | null>(null)
  const [spans, setSpans] = useState<SpanAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [c, l, s] = await Promise.all([
        api.analytics.cost(),
        api.analytics.latency(),
        api.analytics.spans(),
      ])
      setCost(c)
      setLatency(l)
      setSpans(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Initial fetch on mount; aggregates only change meaningfully when a
  // session ends (totals are session-scoped) so we re-pull on
  // `session.ended` rather than on every span.
  useEffect(() => {
    refresh()
  }, [refresh])
  useSessionStream({
    onEvent: (ev) => {
      if (ev.type === "session_ended") refresh()
    },
    onReplayGap: refresh,
  })

  if (error) {
    return (
      <div className="p-8 text-rose-400 font-mono text-sm">
        Failed to load usage: {error}
      </div>
    )
  }

  if (!cost || !latency || !spans) {
    return <div className="p-8 text-zinc-500 font-mono text-sm">Loading…</div>
  }

  return (
    <div className="p-6 space-y-6">
      <Panel
        title="Providers — cost by model"
        subtitle={`${cost.by_model.length} model${cost.by_model.length === 1 ? "" : "s"}`}
      >
        {cost.by_model.length === 0 ? (
          <EmptyRow text="No model spend recorded in this window." />
        ) : (
          <SimpleTable
            columns={["Model", "Cost", "Calls"]}
            aligns={["left", "right", "right"]}
            rows={cost.by_model.map((m) => ({
              key: m.model,
              cells: [
                <span className="text-zinc-200 truncate">{m.model}</span>,
                <span className="text-emerald-400">
                  ${m.cost.toFixed(4)}
                </span>,
                <span className="text-zinc-400">{m.calls}</span>,
              ],
            }))}
          />
        )}
      </Panel>

      <Panel
        title="Tools — cost by agent"
        subtitle={`${cost.by_agent.length} agent${cost.by_agent.length === 1 ? "" : "s"}`}
      >
        {cost.by_agent.length === 0 ? (
          <EmptyRow text="No agent activity recorded in this window." />
        ) : (
          <SimpleTable
            columns={["Agent", "Cost", "Sessions"]}
            aligns={["left", "right", "right"]}
            rows={cost.by_agent.map((a) => ({
              key: a.agent,
              cells: [
                <span className="text-zinc-200 truncate">{a.agent}</span>,
                <span className="text-emerald-400">
                  ${a.cost.toFixed(4)}
                </span>,
                <span className="text-zinc-400">{a.sessions}</span>,
              ],
            }))}
          />
        )}
      </Panel>

      <Panel title="Performance — latency by model">
        {latency.by_model.length === 0 ? (
          <EmptyRow text="No generation spans with duration recorded." />
        ) : (
          <SimpleTable
            columns={["Model", "p50", "p95", "p99"]}
            aligns={["left", "right", "right", "right"]}
            rows={latency.by_model.map((l) => ({
              key: l.model,
              cells: [
                <span className="text-zinc-200 truncate">{l.model}</span>,
                <span className="text-zinc-400">{l.p50_ms}ms</span>,
                <span className="text-zinc-300">{l.p95_ms}ms</span>,
                <span
                  className={
                    l.p99_ms > 5000 ? "text-amber-400" : "text-zinc-300"
                  }
                >
                  {l.p99_ms}ms
                </span>,
              ],
            }))}
          />
        )}
      </Panel>

      <Panel title="Span type distribution">
        {spans.distribution.length === 0 ? (
          <EmptyRow text="No spans recorded." />
        ) : (
          <ul className="divide-y divide-zinc-800">
            {spans.distribution.map((d) => (
              <li
                key={d.type}
                className="flex items-center gap-3 px-4 py-2 text-[13px] font-mono"
              >
                <span className="w-28 text-zinc-300 truncate">{d.type}</span>
                <div className="flex-1 h-2 bg-zinc-900 border border-zinc-800 relative overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-emerald-500/40"
                    style={{ width: `${Math.min(100, d.percentage)}%` }}
                  />
                </div>
                <span className="w-16 text-right text-zinc-400">
                  {d.count}
                </span>
                <span className="w-14 text-right text-zinc-500">
                  {d.percentage.toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="text-[11px] font-mono text-zinc-600 px-1">
        Network sub-panel lands in M4 (depends on kernel proxy Phase 2 +
        /api/net/*).
      </div>
    </div>
  )
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="border border-zinc-800 bg-zinc-900/30">
      <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-[11px] font-mono tracking-wider text-zinc-400 uppercase">
          {title}
        </span>
        {subtitle && (
          <span className="text-[11px] font-mono text-zinc-600">
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="p-4 text-sm text-zinc-600 font-mono">{text}</div>
}

type Align = "left" | "right"

function SimpleTable({
  columns,
  aligns,
  rows,
}: {
  columns: string[]
  aligns: Align[]
  rows: Array<{ key: string; cells: ReactNode[] }>
}) {
  return (
    <table className="w-full text-[13px] font-mono">
      <thead>
        <tr className="text-zinc-500 text-[10px] uppercase tracking-wider">
          {columns.map((c, i) => (
            <th
              key={c}
              className={`font-normal px-4 py-1.5 ${
                aligns[i] === "right" ? "text-right" : "text-left"
              }`}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.key}
            className="border-t border-zinc-800/60 hover:bg-zinc-800/40"
          >
            {r.cells.map((cell, i) => (
              <td
                key={i}
                className={`px-4 py-1.5 ${
                  aligns[i] === "right" ? "text-right" : "text-left"
                } ${aligns[i] === "left" ? "max-w-[320px] truncate" : ""}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ───────────────────────── Evals ─────────────────────────

function EvalsTab() {
  const [rules, setRules] = useState<AlertRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.analytics.alerts()
      setRules(r)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Initial fetch; rules only change when an operator edits them out of
  // band, but kernel auto-score on session.ended can mark them firing,
  // so refetch on session ends and on replay_gap.
  useEffect(() => {
    refresh()
  }, [refresh])
  useSessionStream({
    onEvent: (ev) => {
      if (ev.type === "session_ended") refresh()
    },
    onReplayGap: refresh,
  })

  return (
    <div className="p-6 space-y-6">
      <ScoreLookupPanel />

      <Panel
        title="Alert rules"
        subtitle={
          rules ? `${rules.length} rule${rules.length === 1 ? "" : "s"}` : undefined
        }
      >
        {error && (
          <div className="p-4 text-rose-400 font-mono text-sm">
            Failed to load alert rules: {error}
          </div>
        )}
        {!error && !rules && <EmptyRow text="Loading…" />}
        {rules && rules.length === 0 && (
          <EmptyRow text="No alert rules configured." />
        )}
        {rules && rules.length > 0 && (
          <SimpleTable
            columns={["State", "Name", "Condition", "Threshold", "Action"]}
            aligns={["left", "left", "left", "right", "left"]}
            rows={rules.map((r) => ({
              key: r.id,
              cells: [
                <RuleState enabled={r.enabled} />,
                <span className="text-zinc-200 truncate">{r.name}</span>,
                <span className="text-zinc-400 text-[12px]">
                  {r.condition_type}
                </span>,
                <span className="text-zinc-300">{r.threshold}</span>,
                <span className="text-zinc-500 text-[12px]">{r.action}</span>,
              ],
            }))}
          />
        )}
      </Panel>

      <div className="text-[11px] font-mono text-zinc-600 px-1">
        Firing/silenced state per rule and per-rule pass-rate trends land once
        the kernel grows a list_alert_events + score-name enumeration endpoint.
      </div>
    </div>
  )
}

function RuleState({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-emerald-400">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
      enabled
    </span>
  ) : (
    <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
      disabled
    </span>
  )
}

function ScoreLookupPanel() {
  const [input, setInput] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [summary, setSummary] = useState<ScoreSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!submitted) return
    let cancelled = false
    setLoading(true)
    api.analytics
      .score(submitted)
      .then((s) => {
        if (!cancelled) {
          setSummary(s)
          setError(null)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setSummary(null)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [submitted])

  return (
    <Panel title="Score lookup">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const name = input.trim()
          if (name) setSubmitted(name)
        }}
        className="px-4 py-3 flex items-center gap-2 border-b border-zinc-800"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="score name (e.g. tests_pass, quality)"
          className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-[13px] font-mono text-zinc-200
            focus:outline-none focus:border-emerald-500/40"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="px-3 py-1.5 text-[12px] font-display tracking-wide uppercase
            bg-emerald-500/10 text-emerald-400 border border-emerald-500/25
            hover:bg-emerald-500/20 disabled:opacity-25 disabled:cursor-not-allowed
            cursor-pointer transition-colors"
        >
          Lookup
        </button>
      </form>
      <div className="p-4">
        {!submitted && (
          <div className="text-[13px] text-zinc-500 font-mono">
            Enter a score rule name to see pass/fail totals and rate.
          </div>
        )}
        {submitted && loading && (
          <div className="text-[13px] text-zinc-500 font-mono">Loading…</div>
        )}
        {submitted && error && (
          <div className="text-[13px] font-mono space-y-1">
            <div className="text-rose-400">
              No score named "{submitted}" — try another rule.
            </div>
            <div className="text-zinc-500">
              Common names: <code className="text-zinc-300">tests_pass</code>,{" "}
              <code className="text-zinc-300">quality</code>,{" "}
              <code className="text-zinc-300">loop_detected</code>. Run{" "}
              <code className="text-zinc-300">gctrl analytics scores</code> for
              the full list.
            </div>
            <div className="text-zinc-700 text-[11px]">{error}</div>
          </div>
        )}
        {submitted && summary && (
          <div className="grid grid-cols-4 gap-3">
            <ScoreKpi label="Pass" value={summary.pass} tone="good" />
            <ScoreKpi label="Fail" value={summary.fail} tone="bad" />
            <ScoreKpi
              label="Pass rate"
              value={`${(summary.pass_rate * 100).toFixed(1)}%`}
              tone={summary.pass_rate >= 0.9 ? "good" : "warn"}
            />
            <ScoreKpi
              label="Avg value"
              value={summary.avg_value.toFixed(3)}
              tone="neutral"
            />
          </div>
        )}
      </div>
    </Panel>
  )
}

function ScoreKpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: "good" | "bad" | "warn" | "neutral"
}) {
  const color =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-rose-400"
        : tone === "warn"
          ? "text-amber-400"
          : "text-zinc-200"
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">
        {label}
      </div>
      <div className={`text-xl font-display font-semibold ${color}`}>
        {value}
      </div>
    </div>
  )
}
