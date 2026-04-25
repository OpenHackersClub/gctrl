// Timeline rendering of the same `sessions` state the List view shows.
// Per spec/architecture/apps/gctrl-analytics.md §M2 acceptance:
// "switching list → timeline → heatmap does not re-fetch — same query,
// three renderings." So this component is a pure function of the
// already-loaded session list.
//
// Layout: horizontal lanes per agent_name, one bar per session running
// from `started_at` to `ended_at` (or now, if still live). Bar colour
// is keyed off session status so concurrent agent activity and idle
// gaps are immediately readable.

import type { SessionSummary } from "@/types"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface Props {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}

const LANE_HEIGHT = 22
const LANE_GAP = 4
const LABEL_WIDTH = 140
const AXIS_HEIGHT = 22

export function SessionsTimeline({ sessions, selectedId, onSelect }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="p-8 text-zinc-600 font-mono text-sm text-center">
        No sessions in the current window. Spawn an agent to populate this
        view.
      </div>
    )
  }

  const now = Date.now()
  const ts = sessions.map((s) => new Date(s.started_at).getTime())
  const ends = sessions.map((s) =>
    s.ended_at ? new Date(s.ended_at).getTime() : now,
  )
  const minT = Math.min(...ts)
  const maxT = Math.max(...ends, now)
  const span = Math.max(1, maxT - minT)

  // Group by agent_name into stable, sorted lanes. We sort by lane
  // first so bars in a lane appear in start-time order.
  const lanes = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const key = s.agent_name || "(unknown agent)"
    if (!lanes.has(key)) lanes.set(key, [])
    lanes.get(key)!.push(s)
  }
  const laneList = Array.from(lanes.entries())
    .map(([name, rows]) => ({
      name,
      rows: rows.sort(
        (a, b) =>
          new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const ticks = buildTicks(minT, maxT, 6)
  const totalHeight = laneList.length * (LANE_HEIGHT + LANE_GAP) + AXIS_HEIGHT

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3 text-[11px] font-mono tracking-wider text-zinc-500 uppercase">
        <span>{laneList.length} agents · {sessions.length} sessions</span>
        <span>
          {fmtAbs(minT)} → {fmtAbs(maxT)}
        </span>
      </div>

      <div className="border border-border bg-card/30 overflow-hidden">
        {/* Lanes */}
        <div className="relative" style={{ height: totalHeight }}>
          {/* Vertical gridlines per tick */}
          {ticks.map((t) => {
            const x = LABEL_WIDTH + (t - minT) / span * (100)
            return (
              <div
                key={`grid-${t}`}
                className="absolute top-0 bottom-[22px] w-px bg-border"
                style={{ left: `calc(${LABEL_WIDTH}px + ${((t - minT) / span) * 100}% - ${(LABEL_WIDTH * (t - minT)) / span}px)` }}
                aria-hidden
                data-x={x}
              />
            )
          })}

          {laneList.map((lane, i) => (
            <div
              key={lane.name}
              className="absolute left-0 right-0 flex items-center"
              style={{
                top: i * (LANE_HEIGHT + LANE_GAP),
                height: LANE_HEIGHT,
              }}
            >
              <div
                className="text-[11px] font-mono text-zinc-400 truncate pr-2 text-right"
                style={{ width: LABEL_WIDTH }}
                title={lane.name}
              >
                {lane.name}
              </div>
              <div className="relative flex-1 h-full">
                {lane.rows.map((s) => {
                  const start = new Date(s.started_at).getTime()
                  const end = s.ended_at
                    ? new Date(s.ended_at).getTime()
                    : now
                  const left = ((start - minT) / span) * 100
                  // Floor the width so a single-instant span still shows
                  // a visible nub instead of vanishing.
                  const width = Math.max(0.4, ((end - start) / span) * 100)
                  const isLive = s.ended_at === null && s.status === "active"
                  return (
                    <Tooltip key={s.id}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onSelect(s.id)}
                          aria-label={`Session ${s.id} on agent ${s.agent_name}`}
                          className={cn(
                            "absolute top-1/2 -translate-y-1/2 h-3 rounded-sm cursor-pointer transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            barClass(s.status, isLive),
                            selectedId === s.id
                              ? "ring-1 ring-primary/80"
                              : "hover:opacity-90",
                          )}
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            minWidth: 4,
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="space-y-0.5">
                        <div className="text-foreground">
                          {s.agent_name || "—"}
                        </div>
                        <div className="text-muted-foreground">
                          {fmtAbs(start)} → {s.ended_at ? fmtAbs(end) : "live"}
                        </div>
                        <div className="text-primary">
                          ${s.total_cost_usd.toFixed(4)}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Time axis */}
          <div
            className="absolute left-0 right-0 border-t border-zinc-800 flex items-center"
            style={{
              top: laneList.length * (LANE_HEIGHT + LANE_GAP),
              height: AXIS_HEIGHT,
              paddingLeft: LABEL_WIDTH,
            }}
          >
            <div className="relative flex-1 h-full">
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute top-1 text-[10px] font-mono text-zinc-500"
                  style={{
                    left: `${((t - minT) / span) * 100}%`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {fmtTick(t, span)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Legend />
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-4 mt-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
      <LegendDot className="bg-primary animate-pulse" label="live" />
      <LegendDot className="bg-muted-foreground" label="completed" />
      <LegendDot className="bg-destructive" label="failed" />
      <LegendDot className="bg-amber-500" label="cancelled" />
    </div>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  )
}

function barClass(status: SessionSummary["status"], isLive: boolean): string {
  if (isLive) return "bg-primary animate-pulse"
  if (status === "failed") return "bg-destructive"
  if (status === "cancelled") return "bg-amber-500"
  // completed + fallback
  return "bg-muted-foreground"
}

function buildTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / Math.max(1, count - 1)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(min + step * i)
  return out
}

function fmtAbs(ts: number): string {
  return new Date(ts).toLocaleString()
}

function fmtTick(ts: number, span: number): string {
  const d = new Date(ts)
  // < 24h span: HH:MM. < 7d span: MM/DD HH:MM. Otherwise: MM/DD.
  if (span < 24 * 3600 * 1000) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  if (span < 7 * 24 * 3600 * 1000) {
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}
