import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "@/api/client"
import type {
  ScheduleHealth,
  Schedule,
  ScheduleRun,
  SchedulesSummary,
} from "@/types"
import type { Route } from "@/hooks/useRoute"
import { useScheduleRuns } from "@/hooks/useScheduleRuns"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface SchedulePageProps {
  route: Extract<Route, { page: "schedule" }>
  navigate: (path: string) => void
}

/**
 * `/schedule` — top-of-page CI-style health roll-up + per-routine
 * status grid with deep-link to a detail drawer for run history.
 *
 * Rollup KPIs come from `GET /api/schedules/summary` only — never
 * recomputed in the browser (spec § 5.6). Per-row `health` comes from
 * the kernel's derived column on `GET /api/schedules` (also § 5.6).
 *
 * The Edit tab on the detail drawer is intentionally absent in M1b;
 * `PATCH /api/schedules/{id}` exists kernel-side (M1a PR-3) but the UI
 * surface lands in M1c alongside the `<SessionsTab>` refactor.
 */
export function SchedulePage({ route, navigate }: SchedulePageProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [summary, setSummary] = useState<SchedulesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [list, sum] = await Promise.all([
        api.schedules.list(),
        api.schedules.summary(),
      ])
      setSchedules(list.schedules)
      setSummary(sum)
      setError(null)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // 30s background poll. Per spec § 7.5 a dedicated SSE stream is
    // deferred — at the routine cadence (≤ dozens of fires/day)
    // polling is sufficient.
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const selected = useMemo(
    () =>
      route.name != null
        ? schedules.find((s) => s.name === route.name) ?? null
        : null,
    [route.name, schedules],
  )

  const onSelect = useCallback(
    (s: Schedule | null) => {
      if (s) navigate(`/schedule/${s.name}`)
      else navigate("/schedule")
    },
    [navigate],
  )

  const handleRunNow = useCallback(
    async (s: Schedule) => {
      try {
        await api.schedules.runNow(s.name)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh],
  )

  const handleToggle = useCallback(
    async (s: Schedule) => {
      try {
        if (s.enabled) await api.schedules.disable(s.name)
        else await api.schedules.enable(s.name)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh],
  )

  if (error) {
    return (
      <div className="p-8 text-rose-400 font-mono text-sm" data-testid="schedule-error">
        Failed to load schedules: {error}
        <div className="mt-2 text-zinc-500">
          Is the kernel running on :4318? `gctrld serve` plants
          `_internal.scheduler_runs_gc` on startup; if you can't see
          schedules at all, the daemon is down.
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background">
      <KpiStrip summary={summary} loading={loading} />
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 border-r border-border overflow-auto">
          <StatusGrid
            schedules={schedules}
            loading={loading}
            selectedName={route.name}
            onSelect={onSelect}
            onRunNow={handleRunNow}
            onToggle={handleToggle}
          />
        </div>
        {selected && (
          <RoutineDetailDrawer
            schedule={selected}
            onClose={() => onSelect(null)}
          />
        )}
      </div>
    </div>
  )
}

// ───────────────────────── KPI strip ─────────────────────────

function KpiStrip({
  summary,
  loading,
}: {
  summary: SchedulesSummary | null
  loading: boolean
}) {
  if (loading || !summary) {
    return (
      <div
        className="h-24 border-b border-border flex items-center px-6 text-muted-foreground/70 font-mono text-sm"
        data-testid="schedule-kpi-loading"
      >
        Loading…
      </div>
    )
  }
  const r24 = summary.runs_last_24h
  return (
    <div
      className="grid grid-cols-3 gap-4 p-6 border-b border-border"
      data-testid="schedule-kpi"
    >
      <Kpi
        label="Routines"
        value={summary.total}
        sub={`${summary.by_health.paused} paused`}
      />
      <HealthKpi by={summary.by_health} />
      <RunsKpi runs={r24} />
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] font-mono tracking-wider text-muted-foreground uppercase mb-1">
          {label}
        </div>
        <div className="text-2xl font-display font-semibold text-foreground">
          {value}
        </div>
        {sub && (
          <div className="text-[11px] font-mono text-muted-foreground/70 mt-1">
            {sub}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function HealthKpi({ by }: { by: SchedulesSummary["by_health"] }) {
  const total = by.green + by.amber + by.red + by.pending + by.paused
  return (
    <Card data-testid="schedule-kpi-health">
      <CardContent className="p-4">
        <div className="text-[11px] font-mono tracking-wider text-muted-foreground uppercase mb-2">
          Health
        </div>
        <div className="flex items-end gap-3">
          <Pill tone="green" count={by.green} label="green" />
          <Pill tone="amber" count={by.amber} label="amber" />
          <Pill tone="red" count={by.red} label="red" />
          <Pill tone="muted" count={by.pending} label="pending" />
          <Pill tone="muted" count={by.paused} label="paused" />
        </div>
        {total === 0 && (
          <div className="text-[11px] font-mono text-muted-foreground/70 mt-2">
            no routines registered
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Pill({
  tone,
  count,
  label,
}: {
  tone: "green" | "amber" | "red" | "muted"
  count: number
  label: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    green: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-rose-400",
    muted: "text-zinc-400",
  }
  return (
    <div className="flex flex-col items-start" data-testid={`schedule-pill-${label}`}>
      <span className={cn("text-xl font-display font-semibold", toneClasses[tone])}>
        {count}
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
        {label}
      </span>
    </div>
  )
}

function RunsKpi({ runs }: { runs: SchedulesSummary["runs_last_24h"] }) {
  const total = runs.success + runs.failure
  const pct = total > 0 ? (runs.success / total) * 100 : 0
  return (
    <Card data-testid="schedule-kpi-runs">
      <CardContent className="p-4">
        <div className="text-[11px] font-mono tracking-wider text-muted-foreground uppercase mb-1">
          Runs (24h)
        </div>
        <div className="text-2xl font-display font-semibold text-foreground">
          {total}
        </div>
        {total > 0 && (
          <>
            <div className="mt-2 h-1.5 bg-zinc-900 border border-zinc-800 relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-emerald-500/50"
                style={{ width: `${pct}%` }}
              />
              <div
                className="absolute inset-y-0 right-0 bg-rose-500/50"
                style={{ width: `${100 - pct}%` }}
              />
            </div>
            <div className="flex gap-3 mt-1 text-[10px] font-mono text-muted-foreground/70">
              <span className="text-emerald-400">{runs.success}</span>
              <span>/</span>
              <span className={runs.failure > 0 ? "text-rose-400" : ""}>
                {runs.failure}
              </span>
            </div>
          </>
        )}
        {total === 0 && (
          <div className="text-[11px] font-mono text-muted-foreground/70 mt-1">
            no fires in the last 24h
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ───────────────────────── Status grid ─────────────────────────

function StatusGrid({
  schedules,
  loading,
  selectedName,
  onSelect,
  onRunNow,
  onToggle,
}: {
  schedules: Schedule[]
  loading: boolean
  selectedName: string | null
  onSelect: (s: Schedule) => void
  onRunNow: (s: Schedule) => void
  onToggle: (s: Schedule) => void
}) {
  if (loading) {
    return (
      <div
        className="p-8 text-muted-foreground/70 font-mono text-sm"
        data-testid="schedule-grid-loading"
      >
        Loading schedules…
      </div>
    )
  }
  if (schedules.length === 0) {
    return (
      <div
        className="p-8 text-muted-foreground/70 font-mono text-sm leading-relaxed"
        data-testid="schedule-empty"
      >
        No routines registered yet.
        <div className="mt-2 text-zinc-600 text-[12px]">
          The daemon plants <code>_internal.scheduler_runs_gc</code> on
          startup automatically. User routines come from{" "}
          <code>POST /api/schedules</code> (or vault catalog presets in M2).
        </div>
      </div>
    )
  }
  // Group by name prefix per spec § 6.2 (`audit.*`, `gap.*`, …).
  const grouped = groupByPrefix(schedules)
  return (
    <div className="p-4 space-y-6" data-testid="schedule-grid">
      {grouped.map(({ prefix, rows }) => (
        <div key={prefix}>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 mb-2 px-2">
            {prefix}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {rows.map((s) => (
              <RoutineCard
                key={s.id}
                schedule={s}
                selected={s.name === selectedName}
                onSelect={() => onSelect(s)}
                onRunNow={() => onRunNow(s)}
                onToggle={() => onToggle(s)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function groupByPrefix(
  schedules: Schedule[],
): { prefix: string; rows: Schedule[] }[] {
  const map = new Map<string, Schedule[]>()
  for (const s of schedules) {
    // First dotted segment, or "other" if the name has no dot.
    const idx = s.name.indexOf(".")
    const prefix = idx > 0 ? s.name.slice(0, idx) : "other"
    if (!map.has(prefix)) map.set(prefix, [])
    map.get(prefix)!.push(s)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, rows]) => ({
      prefix,
      rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

function RoutineCard({
  schedule,
  selected,
  onSelect,
  onRunNow,
  onToggle,
}: {
  schedule: Schedule
  selected: boolean
  onSelect: () => void
  onRunNow: () => void
  onToggle: () => void
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors",
        selected
          ? "border-primary/40 bg-primary/5"
          : "hover:border-zinc-700/80",
      )}
      onClick={onSelect}
      data-testid="schedule-card"
      data-routine-name={schedule.name}
    >
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-mono text-foreground truncate">
              {schedule.name}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground/70 mt-0.5">
              <code>{schedule.cron}</code>
            </div>
          </div>
          <HealthBadge health={schedule.health} />
        </div>
        <Sparkline scheduleName={schedule.name} />
        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground/70">
          <span>
            last:{" "}
            {schedule.last_run_at
              ? formatRelative(schedule.last_run_at)
              : "—"}
          </span>
          <span className="text-zinc-700">·</span>
          <span>
            next:{" "}
            {schedule.next_run_at
              ? formatRelative(schedule.next_run_at)
              : "—"}
          </span>
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRunNow()
            }}
            data-testid="schedule-run-now"
            className="px-2.5 py-1 text-[11px] font-mono border border-emerald-500/30 text-emerald-300
              hover:bg-emerald-500/10 transition-colors"
          >
            run now
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            data-testid="schedule-toggle"
            className={cn(
              "px-2.5 py-1 text-[11px] font-mono border transition-colors",
              schedule.enabled
                ? "border-zinc-700 text-zinc-300 hover:bg-zinc-800/60"
                : "border-amber-500/30 text-amber-300 hover:bg-amber-500/10",
            )}
          >
            {schedule.enabled ? "disable" : "enable"}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

function HealthBadge({ health }: { health: ScheduleHealth | undefined }) {
  // `health` should always be present on rows from the kernel, but
  // tolerate `undefined` defensively (older daemon). Treat unknown as
  // muted rather than throwing.
  const tone = HEALTH_TONE[health ?? "pending"]
  return (
    <span
      className={cn(
        "px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border rounded-sm shrink-0",
        tone.text,
        tone.border,
        tone.bg,
      )}
      data-testid="schedule-health"
      data-health={health ?? "unknown"}
    >
      {health ?? "unknown"}
    </span>
  )
}

const HEALTH_TONE: Record<
  ScheduleHealth,
  { text: string; border: string; bg: string }
> = {
  green: {
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
  },
  amber: {
    text: "text-amber-400",
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
  },
  red: {
    text: "text-rose-400",
    border: "border-rose-500/30",
    bg: "bg-rose-500/10",
  },
  pending: {
    text: "text-zinc-400",
    border: "border-zinc-700",
    bg: "bg-zinc-900",
  },
  paused: {
    text: "text-zinc-500",
    border: "border-zinc-800",
    bg: "bg-transparent",
  },
}

// ───────────────────────── Sparkline ─────────────────────────

/** Adaptive window per spec § 7.1: last 30 days for daily-or-faster
 *  routines, last 12 weeks for weekly. We use a heuristic on the cron
 *  string — if it has a fixed day-of-week field (5th token), treat
 *  it as weekly. Otherwise daily-or-faster. */
function sparklineWindowDays(cron: string): number {
  const tokens = cron.trim().split(/\s+/)
  // Standard 5-field cron: m h dom mon dow. dow is index 4.
  // 6-field (with seconds): index 5. 7-field (with year): same index 5.
  const dow = tokens.length === 5 ? tokens[4] : tokens[5] ?? ""
  // A fixed dow means weekly cadence (e.g. "1" or "Mon"). Wildcards `*`
  // and step `*/N` are NOT weekly.
  const isWeekly = dow !== "" && dow !== "*" && !dow.startsWith("*/")
  return isWeekly ? 12 * 7 : 30
}

function Sparkline({ scheduleName }: { scheduleName: string }) {
  // Lazy: each card triggers its own runs query. At dozens of routines
  // this is cheap and avoids a second prefetch. M1c will revisit if
  // it shows up in CDP / heap traces.
  const days = useMemo(() => 30, [])
  const since = useMemo(
    () => new Date(Date.now() - days * 86_400_000).toISOString(),
    [days],
  )
  const { runs, loading } = useScheduleRuns(scheduleName, { since, limit: 30 })

  if (loading) {
    return (
      <div className="h-3 flex items-center text-[10px] font-mono text-muted-foreground/40">
        loading…
      </div>
    )
  }
  if (runs.length === 0) {
    return (
      <div
        className="h-3 flex items-center text-[10px] font-mono text-muted-foreground/40"
        data-testid="schedule-sparkline-empty"
      >
        no fires yet
      </div>
    )
  }
  // Latest first → render right-to-left so the rightmost dot is most recent.
  const ordered = [...runs].reverse()
  return (
    <div
      className="h-3 flex items-center gap-0.5"
      data-testid="schedule-sparkline"
      data-runs-count={ordered.length}
    >
      {ordered.map((r) => (
        <span
          key={r.id}
          className={cn(
            "block w-1.5 h-3 rounded-[1px]",
            r.status === "success"
              ? "bg-emerald-500/70"
              : r.status === "interrupted"
                ? "bg-zinc-500/60"
                : "bg-rose-500/70",
          )}
          title={`${r.status} at ${new Date(r.started_at).toLocaleString()}`}
        />
      ))}
    </div>
  )
}

// ───────────────────────── Detail drawer ─────────────────────────

function RoutineDetailDrawer({
  schedule,
  onClose,
}: {
  schedule: Schedule
  onClose: () => void
}) {
  const { runs, loading, error } = useScheduleRuns(schedule.name, { limit: 50 })
  return (
    <aside
      className="w-[480px] min-w-[480px] bg-zinc-950 border-l border-zinc-800 flex flex-col overflow-hidden"
      data-testid="schedule-drawer"
    >
      <header className="h-10 border-b border-zinc-800 flex items-center justify-between px-4">
        <div className="text-[11px] font-mono tracking-wider text-zinc-400 uppercase truncate">
          {schedule.name}
        </div>
        <button
          onClick={onClose}
          data-testid="schedule-drawer-close"
          className="text-zinc-500 hover:text-zinc-200 text-lg leading-none cursor-pointer"
          title="Close"
        >
          ×
        </button>
      </header>

      <div className="p-4 space-y-2 border-b border-zinc-800">
        <DetailRow label="Cron" value={<code>{schedule.cron}</code>} />
        <DetailRow label="Target" value={schedule.target_kind.toUpperCase()} />
        <DetailRow
          label="Health"
          value={<HealthBadge health={schedule.health} />}
        />
        <DetailRow
          label="Run / fail"
          value={`${schedule.run_count} / ${schedule.failure_count}`}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 border-b border-zinc-800">
          Runs
        </div>
        {loading && (
          <div className="p-4 text-zinc-500 font-mono text-[12px]">
            Loading run history…
          </div>
        )}
        {error && (
          <div className="p-4 text-rose-400 font-mono text-[12px]">
            Failed to load runs: {error}
          </div>
        )}
        {!loading && !error && runs.length === 0 && (
          <div
            className="p-4 text-zinc-500 font-mono text-[12px]"
            data-testid="schedule-drawer-empty-runs"
          >
            No fire history yet.
          </div>
        )}
        {!loading && !error && runs.length > 0 && (
          <ul className="divide-y divide-zinc-800" data-testid="schedule-runs-list">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function DetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between text-[12px] font-mono">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
        {label}
      </span>
      <span className="text-zinc-200 truncate max-w-[60%] text-right">
        {value}
      </span>
    </div>
  )
}

function RunRow({ run }: { run: ScheduleRun }) {
  const [expanded, setExpanded] = useState(false)
  const tone =
    run.status === "success"
      ? "text-emerald-400 border-emerald-500/30"
      : run.status === "interrupted"
        ? "text-zinc-400 border-zinc-700"
        : "text-rose-400 border-rose-500/30"
  return (
    <li className="px-4 py-2" data-testid="schedule-run-row" data-run-status={run.status}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 text-[12px] font-mono cursor-pointer"
      >
        <span
          className={cn(
            "px-1.5 py-px text-[10px] uppercase tracking-wider border rounded-sm",
            tone,
          )}
        >
          {run.status}
        </span>
        <span className="text-muted-foreground/70">
          {new Date(run.started_at).toLocaleString()}
        </span>
        <span className="ml-auto text-muted-foreground/70">
          {run.duration_ms != null ? `${run.duration_ms}ms` : "—"}
        </span>
      </button>
      {expanded && (run.error_preview || run.response_preview) && (
        <pre
          className="mt-2 px-3 py-2 bg-zinc-950/40 border border-zinc-800 text-[11px] text-zinc-300 whitespace-pre-wrap break-words"
          data-testid="schedule-run-detail"
        >
          {run.error_preview ?? run.response_preview}
        </pre>
      )}
    </li>
  )
}

function formatRelative(rfc3339: string): string {
  const ms = new Date(rfc3339).getTime() - Date.now()
  const abs = Math.abs(ms)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)
  const sign = ms < 0 ? "-" : "+"
  if (sec < 60) return `${sign}${sec}s`
  if (min < 60) return `${sign}${min}m`
  if (hr < 48) return `${sign}${hr}h`
  return `${sign}${day}d`
}
