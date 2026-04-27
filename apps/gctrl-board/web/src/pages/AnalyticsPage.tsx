import { useCallback, useEffect, useState, type ReactNode } from "react"
import { api, type AnalyticsSyncStatus } from "@/api/client"
import type {
  AnalyticsOverview,
  CostAnalytics,
  ContributionRow,
  SessionSummary,
  SessionKind,
  TraceTreeNode,
  TraceTreeResponse,
  LatencyAnalytics,
  SpanAnalytics,
  ScoreSummary,
  AlertRule,
} from "@/types"
import type { Route } from "@/hooks/useRoute"
import { useSessionStream } from "@/hooks/useSessionStream"
import { SessionsTimeline } from "@/components/analytics/SessionsTimeline"
import { SessionsHeatmap } from "@/components/analytics/SessionsHeatmap"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type SessionsView = "list" | "timeline" | "heatmap"

interface AnalyticsPageProps {
  route: Extract<Route, { page: "analytics" }>
  navigate: (path: string) => void
}

const TABS = ["overview", "sessions", "usage", "evals", "contributions"] as const

const TAB_PATH: Record<(typeof TABS)[number], string> = {
  overview: "/analytics/overview",
  sessions: "/analytics/sessions",
  usage: "/analytics/usage",
  evals: "/analytics/evals",
  contributions: "/analytics/contributions",
}

export function AnalyticsPage({ route, navigate }: AnalyticsPageProps) {
  // Global attribution filter — applies to every tab.
  // `internal` = scheduler+api, `external` = otel_ingest (analytics §1).
  const [kind, setKind] = useState<SessionKind>("all")

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Tab bar — radix Tabs.List with shadcn styling. We keep the
         * router as the source of truth for the active tab; Tabs is
         * controlled. */}
        <div className="h-10 border-b border-border flex items-center px-4 bg-background/90">
          <Tabs
            value={route.tab}
            onValueChange={(v) =>
              navigate(TAB_PATH[v as (typeof TABS)[number]] ?? "/analytics")
            }
            className="flex-1"
          >
            <TabsList className="border-b-0 -mb-px">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
              <TabsTrigger value="evals">Evals</TabsTrigger>
              <TabsTrigger value="contributions">Contributions</TabsTrigger>
            </TabsList>
          </Tabs>
          <KindFilter kind={kind} onChange={setKind} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex ml-3">
                <Badge variant="success" dot pulse>
                  live
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Live updates stream from /api/sessions/stream — no polling.
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Tab body */}
        <div className="flex-1 min-h-0 overflow-auto">
          {route.tab === "overview" && <OverviewTab kind={kind} />}
          {route.tab === "sessions" && (
            <SessionsTab
              selectedSessionId={route.sessionId}
              onSelectSession={(id) =>
                navigate(id ? `/analytics/sessions/${id}` : "/analytics/sessions")
              }
              kind={kind}
            />
          )}
          {route.tab === "usage" && <UsageTab kind={kind} />}
          {route.tab === "evals" && <EvalsTab />}
          {route.tab === "contributions" && <ContributionsTab kind={kind} />}
        </div>
      </div>
    </TooltipProvider>
  )
}

function KindFilter({
  kind,
  onChange,
}: {
  kind: SessionKind
  onChange: (k: SessionKind) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(v) => {
            if (v) onChange(v as SessionKind)
          }}
        >
          <ToggleGroupItem value="all" data-testid="kind-all">
            all
          </ToggleGroupItem>
          <ToggleGroupItem value="internal" data-testid="kind-internal">
            internal
          </ToggleGroupItem>
          <ToggleGroupItem value="external" data-testid="kind-external">
            external
          </ToggleGroupItem>
        </ToggleGroup>
      </TooltipTrigger>
      <TooltipContent>
        internal = scheduler+api, external = otel-ingested. See analytics spec §1.
      </TooltipContent>
    </Tooltip>
  )
}

// ───────────────────────── Overview ─────────────────────────

function OverviewTab({ kind }: { kind: SessionKind }) {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [cost, setCost] = useState<CostAnalytics | null>(null)
  const [liveCount, setLiveCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<AnalyticsSyncStatus | null>(null)

  // Live count + the rollup KPIs all respect the kind filter — kernel
  // /api/analytics and /api/analytics/cost accept `?kind=` since the M3
  // follow-up shipped, so the page no longer mixes filtered and
  // population-wide totals on the same row.
  const refresh = useCallback(async () => {
    try {
      const [o, c, live, sync] = await Promise.all([
        api.analytics.overview(kind),
        api.analytics.cost(kind),
        // Kernel's /api/analytics rollup has no active_sessions field;
        // count from sessions.list?status=active instead.
        api.sessions.list({ status: "active", limit: 200, kind }),
        api.analytics.syncStatus().catch(() => null),
      ])
      setOverview(o)
      setCost(c)
      setLiveCount(live.length)
      setSyncStatus(sync)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [kind])

  // Initial fetch on mount + on kind change.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Live updates: stream lifecycle events, but only adjust the count
  // when the event matches the active kind filter. We rely on a fresh
  // fetch to pick up `created_by` for new sessions.
  useSessionStream({
    onEvent: (ev) => {
      if (ev.type === "session_started") {
        // We don't know the new row's created_by from the event alone
        // (event payload is intentionally narrow). When `all` is
        // active, just bump; otherwise refetch so we count correctly.
        if (kind === "all") {
          setLiveCount((n) => (n ?? 0) + 1)
        } else {
          refresh()
        }
      } else if (ev.type === "session_ended") {
        if (kind === "all") {
          setLiveCount((n) => Math.max(0, (n ?? 0) - 1))
        }
        refresh()
      }
    },
    onReplayGap: refresh,
  })

  if (error) {
    // Hint depends on deployment shape: in dev (Vite) the page hits the kernel
    // directly via :4318; in preview/prod the Worker serves from D1 and pulls
    // from KERNEL_URL on a cron. Surface whichever is relevant.
    const hint =
      syncStatus === null
        ? "Is the kernel running on :4318? (or the Worker on the configured host)"
        : !syncStatus.kernel_url_configured
          ? "Worker is running but KERNEL_URL is not configured — set it via `wrangler secret put KERNEL_URL`."
          : "Last sync state is below — check resources marked `error`."
    return (
      <div className="p-8 text-rose-400 font-mono text-sm">
        Failed to load overview: {error}
        <div className="mt-2 text-zinc-500">{hint}</div>
        {syncStatus && <SyncStatusPanel status={syncStatus} />}
      </div>
    )
  }

  // Empty state — analytics tables exist but never synced. The Worker returns
  // zeros rather than 404, so we detect "never synced" via sync-status.
  const neverSynced =
    overview.total_sessions === 0 &&
    syncStatus !== null &&
    syncStatus.resources.length === 0
  if (neverSynced) {
    return (
      <div className="p-8 text-zinc-400 font-mono text-sm space-y-3">
        <div className="text-zinc-200">No analytics data yet.</div>
        {syncStatus.kernel_url_configured ? (
          <>
            <div>The kernel sync hasn't run yet — it ticks every 2 minutes.</div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const s = await api.analytics.sync()
                  setSyncStatus(s)
                  refresh()
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Sync now
            </Button>
          </>
        ) : (
          <div>
            KERNEL_URL is not configured on this Worker — analytics will stay
            empty until it's set.
          </div>
        )}
      </div>
    )
  }

  if (!overview) {
    return <div className="p-8 text-zinc-500 font-mono text-sm">Loading…</div>
  }

  // Every KPI now reflects the active kind filter — no more split label.
  const kindSuffix = kind === "all" ? "" : ` (${kind})`
  const liveLabel = kind === "all" ? "Live sessions" : `Live (${kind})`

  return (
    <div className="p-6 space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <Kpi label={liveLabel} value={liveCount ?? "—"} accent />
        <Kpi
          label={`Total sessions${kindSuffix}`}
          value={overview.total_sessions}
        />
        <Kpi
          label={`Spans${kindSuffix}`}
          value={overview.total_spans.toLocaleString()}
        />
        <Kpi
          label={`Total cost${kindSuffix}`}
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
    <Card
      className={cn(
        accent && "border-primary/30 bg-primary/5",
      )}
    >
      <CardContent className="p-4">
        <div className="text-[11px] font-mono tracking-wider text-muted-foreground uppercase mb-1">
          {label}
        </div>
        <div
          className={cn(
            "text-2xl font-display font-semibold",
            accent ? "text-primary" : "text-foreground",
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent className="text-sm text-muted-foreground/70">
          No data yet.
        </CardContent>
      ) : (
        <Table>
          <TableHeader className="bg-card/30">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">{rows[0].countLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="text-foreground truncate max-w-[240px]">
                  {r.primary}
                </TableCell>
                <TableCell className="text-right text-primary">
                  ${r.cost.toFixed(4)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {r.count}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

// ───────────────────────── Sessions ─────────────────────────

function SessionsTab({
  selectedSessionId,
  onSelectSession,
  kind,
}: {
  selectedSessionId: string | null
  onSelectSession: (id: string | null) => void
  kind: SessionKind
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // View-mode is local state on purpose: per spec, switching list →
  // timeline → heatmap must NOT re-fetch. Same data, three renderings.
  const [view, setView] = useState<SessionsView>("list")

  const refresh = useCallback(async () => {
    try {
      const list = await api.sessions.list({ limit: 100, kind })
      setSessions(list)
      setError(null)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [kind])

  // Initial fetch on mount + on kind change.
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
        // The kind filter requires knowing `created_by` to decide
        // whether to show the row. The event payload deliberately
        // omits provenance, so when filtering we refetch instead of
        // showing a placeholder we'd then have to retract.
        if (kind !== "all") {
          refresh()
          return
        }
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
            // Provenance unknown until the next refresh — `unknown`
            // is the spec-sanctioned placeholder for that.
            created_by: "unknown",
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
    <div className="flex flex-col h-full min-h-0">
      {/* View-mode switcher — same data, three renderings */}
      <div className="h-9 border-b border-border flex items-center px-4 gap-3 bg-background/60 shrink-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
          view
        </span>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => {
            // Radix emits "" when the active item is clicked. Ignore
            // that — view-mode is required, not toggle-able to empty.
            if (v) setView(v as SessionsView)
          }}
        >
          <ToggleGroupItem value="list" data-testid="sessions-view-list">
            list
          </ToggleGroupItem>
          <ToggleGroupItem value="timeline" data-testid="sessions-view-timeline">
            timeline
          </ToggleGroupItem>
          <ToggleGroupItem value="heatmap" data-testid="sessions-view-heatmap">
            heatmap
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-muted-foreground">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Body — switches by view; each renderer is a pure function of `sessions` */}
        <div className="flex-1 min-w-0 border-r border-border overflow-auto">
          {view === "list" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Dur</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && sessions.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="p-8 text-center text-muted-foreground/70"
                    >
                      Loading sessions…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && sessions.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="p-8 text-center text-muted-foreground/70"
                    >
                      No sessions yet. Spawn an agent and this table will
                      populate.
                    </TableCell>
                  </TableRow>
                )}
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    selected={s.id === selectedSessionId}
                    onSelect={() => onSelectSession(s.id)}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          {view === "timeline" && (
            <SessionsTimeline
              sessions={sessions}
              selectedId={selectedSessionId}
              onSelect={onSelectSession}
            />
          )}

          {view === "heatmap" && (
            <SessionsHeatmap
              sessions={sessions}
              selectedId={selectedSessionId}
              onSelect={onSelectSession}
            />
          )}
        </div>

        {/* Detail pane is shared across all three views */}
        {selected && (
          <SessionDetailPane
            session={selected}
            onClose={() => onSelectSession(null)}
          />
        )}
      </div>
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
    <TableRow
      onClick={onSelect}
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
    >
      <TableCell>
        <StatusBadge status={session.status} live={isLive} />
      </TableCell>
      <TableCell className="text-foreground truncate max-w-[180px]">
        {session.agent_name || "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-[12px]">
        {new Date(session.started_at).toLocaleString()}
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-[12px]">
        {formatDuration(durationMs)}
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-[12px]">
        {(session.total_input_tokens + session.total_output_tokens).toLocaleString()}
      </TableCell>
      <TableCell className="text-right text-primary">
        ${session.total_cost_usd.toFixed(4)}
      </TableCell>
      <TableCell className="text-muted-foreground/70 text-[11px] truncate max-w-[160px]">
        {session.id}
      </TableCell>
    </TableRow>
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
      <Badge variant="success" dot pulse>
        live
      </Badge>
    )
  }
  const variant =
    status === "completed"
      ? "muted"
      : status === "failed"
        ? "destructive"
        : status === "cancelled"
          ? "warn"
          : "muted"
  return <Badge variant={variant}>{status}</Badge>
}

function ProvenanceBadge({ createdBy }: { createdBy: SessionSummary["created_by"] }) {
  // Map raw created_by ⇒ derived view label so operators read the
  // same vocabulary the filter uses. We still show the raw value as
  // a sub-line so /analytics/sessions/<id> doesn't drop signal that
  // an external tooling integration cares about.
  const view: "internal" | "external" | "unknown" =
    createdBy === "scheduler" || createdBy === "api"
      ? "internal"
      : createdBy === "otel_ingest"
        ? "external"
        : "unknown"
  const color =
    view === "internal"
      ? "text-emerald-400"
      : view === "external"
        ? "text-sky-400"
        : "text-zinc-500"
  return (
    <span className={`text-[11px] font-mono uppercase tracking-wider ${color}`}>
      {view} <span className="text-zinc-600">({createdBy})</span>
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
          <DetailField
            label="Provenance"
            value={<ProvenanceBadge createdBy={session.created_by} />}
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

function UsageTab({ kind }: { kind: SessionKind }) {
  const [cost, setCost] = useState<CostAnalytics | null>(null)
  const [latency, setLatency] = useState<LatencyAnalytics | null>(null)
  const [spans, setSpans] = useState<SpanAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [c, l, s] = await Promise.all([
        api.analytics.cost(kind),
        api.analytics.latency(kind),
        api.analytics.spans(kind),
      ])
      setCost(c)
      setLatency(l)
      setSpans(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [kind])

  // Initial fetch on mount + on kind change; aggregates only change
  // meaningfully when a session ends (totals are session-scoped) so we
  // re-pull on `session.ended` rather than on every span.
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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {subtitle && (
          <span className="text-[11px] font-mono text-muted-foreground/70">
            {subtitle}
          </span>
        )}
      </CardHeader>
      {children}
    </Card>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <CardContent className="text-sm text-muted-foreground/70">
      {text}
    </CardContent>
  )
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
    <Table>
      <TableHeader className="bg-card/30">
        <TableRow>
          {columns.map((c, i) => (
            <TableHead
              key={c}
              className={cn(aligns[i] === "right" && "text-right")}
            >
              {c}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            {r.cells.map((cell, i) => (
              <TableCell
                key={i}
                className={cn(
                  aligns[i] === "right" && "text-right",
                  aligns[i] === "left" && "max-w-[320px] truncate",
                )}
              >
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    <Badge variant="success" dot>
      enabled
    </Badge>
  ) : (
    <Badge variant="muted">disabled</Badge>
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
        className="px-4 py-3 flex items-center gap-2 border-b border-border"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="score name (e.g. tests_pass, quality)"
          className="flex-1 bg-background border border-input px-3 py-1.5 text-[13px] font-mono text-foreground
            focus:outline-none focus:border-ring"
        />
        <Button type="submit" disabled={!input.trim()} size="sm">
          Lookup
        </Button>
      </form>
      <CardContent>
        {!submitted && (
          <div className="text-[13px] text-muted-foreground font-mono">
            Enter a score rule name to see pass/fail totals and rate.
          </div>
        )}
        {submitted && loading && (
          <div className="text-[13px] text-muted-foreground font-mono">
            Loading…
          </div>
        )}
        {submitted && error && (
          <div className="text-[13px] font-mono space-y-1">
            <div className="text-destructive">
              No score named "{submitted}" — try another rule.
            </div>
            <div className="text-muted-foreground">
              Common names:{" "}
              <code className="text-foreground">tests_pass</code>,{" "}
              <code className="text-foreground">quality</code>,{" "}
              <code className="text-foreground">loop_detected</code>. Run{" "}
              <code className="text-foreground">gctrl analytics scores</code>{" "}
              for the full list.
            </div>
            <div className="text-muted-foreground/50 text-[11px]">{error}</div>
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
      </CardContent>
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
      ? "text-primary"
      : tone === "bad"
        ? "text-destructive"
        : tone === "warn"
          ? "text-amber-400"
          : "text-foreground"
  return (
    <Card className="bg-background">
      <CardContent className="p-3">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
          {label}
        </div>
        <div className={cn("text-xl font-display font-semibold", color)}>
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

// ───────────────────────── Contributions ─────────────────────────

// Until the kernel exposes a workspace→repo mapping, the operator
// configures it locally. Most of the dogfooding happens against the
// gctrl repo itself, so default to that. Stored under localStorage so
// the choice survives reloads without bloating the URL.
const CONTRIB_REPO_KEY = "gctrl.analytics.contribRepo"
const DEFAULT_CONTRIB_REPO = "OpenHackersClub/gctrl"

function ContributionsTab({ kind }: { kind: SessionKind }) {
  const [repo, setRepo] = useState<string>(
    () =>
      (typeof window !== "undefined" &&
        window.localStorage.getItem(CONTRIB_REPO_KEY)) ||
      DEFAULT_CONTRIB_REPO,
  )
  const [rows, setRows] = useState<ContributionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.contributions.list({ repo, kind, limit: 30 })
      setRows(res.contributions)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRows(null)
    } finally {
      setLoading(false)
    }
  }, [repo, kind])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Contributions</CardTitle>
            <span className="text-[11px] font-mono text-muted-foreground/70">
              PRs joined to sessions via{" "}
              <code className="text-foreground">Session-Id:</code> commit
              trailers — see analytics spec §M5
            </span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              window.localStorage.setItem(CONTRIB_REPO_KEY, repo)
              refresh()
            }}
            className="flex items-center gap-2"
          >
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              className="bg-background border border-input px-3 py-1.5 text-[13px] font-mono text-foreground w-56
                focus:outline-none focus:border-ring"
            />
            <Button type="submit" size="sm" disabled={!repo.trim() || loading}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </form>
        </CardHeader>

        {error && (
          <CardContent className="text-rose-400 font-mono text-sm">
            Failed to load: {error}
            <div className="mt-1 text-muted-foreground/70 text-[11px]">
              The kernel shells out to <code>gh pr list</code> for this route — make sure{" "}
              <code>gh auth status</code> is OK on the kernel host.
            </div>
          </CardContent>
        )}

        {!error && rows && rows.length === 0 && (
          <EmptyRow
            text={
              kind === "all"
                ? `No PRs found in ${repo}.`
                : `No PRs in ${repo} match kind=${kind}. Unattributed PRs are dropped when a kind filter is active — switch back to "all" to see them.`
            }
          />
        )}

        {rows && rows.length > 0 && (
          <SimpleTable
            columns={["", "PR", "Title", "Author", "Session", "State"]}
            aligns={["left", "right", "left", "left", "left", "left"]}
            rows={rows.map((r) => ({
              key: `${r.type}-${r.number}`,
              cells: [
                <ContribTypeBadge type={r.type} />,
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline tabular-nums"
                >
                  #{r.number}
                </a>,
                <span className="text-zinc-200 truncate">{r.title}</span>,
                <span className="text-zinc-400 text-[12px]">{r.author}</span>,
                <ContribSessionCell row={r} />,
                <ContribStateBadge state={r.state} />,
              ],
            }))}
          />
        )}
      </Card>

      <div className="text-[11px] font-mono text-zinc-600 px-1">
        Initial cut surfaces PRs only. <code>gh search commits</code> +
        closed-issues join land in a follow-up; missing trailers are
        kept as <span className="text-zinc-400">unattributed</span>{" "}
        rows per spec §4 (loss-tolerant inference).
      </div>
    </div>
  )
}

function ContribTypeBadge({ type }: { type: "pr" | "commit" }) {
  return type === "pr" ? (
    <Badge variant="muted">pr</Badge>
  ) : (
    <Badge variant="muted">commit</Badge>
  )
}

function ContribStateBadge({ state }: { state: string }) {
  const upper = state?.toUpperCase()
  if (upper === "MERGED") return <Badge variant="success">merged</Badge>
  if (upper === "CLOSED") return <Badge variant="muted">closed</Badge>
  if (upper === "OPEN") return <Badge variant="success" dot>open</Badge>
  return <Badge variant="muted">{state || "—"}</Badge>
}

function ContribSessionCell({ row }: { row: ContributionRow }) {
  if (!row.session_id) {
    return (
      <span className="text-muted-foreground/60 text-[12px] italic">
        unattributed
      </span>
    )
  }
  return (
    <a
      href={`/analytics/sessions/${row.session_id}`}
      className="text-primary hover:underline text-[12px] font-mono"
      title={`agent ${row.session_agent ?? "?"}, kind ${row.created_by ?? "?"}`}
    >
      {row.session_agent ?? row.session_id.slice(0, 8)}
    </a>
  )
}

function SyncStatusPanel({ status }: { status: AnalyticsSyncStatus }) {
  if (status.resources.length === 0) {
    return (
      <div className="mt-4 text-zinc-500 text-xs">
        No sync attempts recorded yet.
      </div>
    )
  }
  return (
    <div className="mt-4 text-xs">
      <div className="text-zinc-400 mb-1">Sync state by resource:</div>
      <ul className="space-y-0.5">
        {status.resources.map((r) => (
          <li key={r.resource} className="flex gap-2">
            <span
              className={cn(
                "font-mono",
                r.last_status === "ok" ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {r.last_status === "ok" ? "✓" : "✗"} {r.resource}
            </span>
            <span className="text-zinc-500">{r.last_synced_at}</span>
            {r.last_error && <span className="text-rose-400">{r.last_error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
