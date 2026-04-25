// Heatmap rendering of the same `sessions` state.
// Per spec/architecture/apps/gctrl-analytics.md §M2: agent × hour-of-day
// grid, cell intensity = session count or cost. Reveals activity
// patterns ("agent X always burns the morning") that a flat list buries.

import { useMemo, useState } from "react"
import type { SessionSummary } from "../../types"

interface Props {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}

type Mode = "count" | "cost"

const HOURS = 24

export function SessionsHeatmap({ sessions, selectedId, onSelect }: Props) {
  const [mode, setMode] = useState<Mode>("count")

  const { agents, grid, max, perCellSessions } = useMemo(
    () => bucketize(sessions, mode),
    [sessions, mode],
  )

  if (sessions.length === 0) {
    return (
      <div className="p-8 text-zinc-600 font-mono text-sm text-center">
        No sessions in the current window.
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-mono tracking-wider text-zinc-500 uppercase">
          {agents.length} agents · 24 hours · intensity = {mode}
        </span>
        <div className="flex gap-px bg-zinc-800/60 p-px">
          <ModeButton
            active={mode === "count"}
            onClick={() => setMode("count")}
            label="count"
          />
          <ModeButton
            active={mode === "cost"}
            onClick={() => setMode("cost")}
            label="cost"
          />
        </div>
      </div>

      <div className="border border-zinc-800 bg-zinc-900/30 p-3 overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th aria-hidden />
              {Array.from({ length: HOURS }, (_, h) => (
                <th
                  key={h}
                  className="text-[10px] font-mono text-zinc-500 font-normal w-7 text-center pb-1"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent}>
                <td
                  className="text-[11px] font-mono text-zinc-400 pr-3 text-right truncate"
                  style={{ maxWidth: 160 }}
                  title={agent}
                >
                  {agent}
                </td>
                {Array.from({ length: HOURS }, (_, h) => {
                  const cell = grid.get(`${agent}|${h}`) ?? 0
                  const cellSessions = perCellSessions.get(`${agent}|${h}`)
                  const intensity = max > 0 ? cell / max : 0
                  const onCellSelect = () => {
                    if (cellSessions && cellSessions.length > 0) {
                      onSelect(cellSessions[0].id)
                    }
                  }
                  return (
                    <td
                      key={h}
                      onClick={onCellSelect}
                      title={
                        cellSessions && cellSessions.length > 0
                          ? `${agent} @ ${h}:00 — ${
                              mode === "count"
                                ? `${cell} session${cell === 1 ? "" : "s"}`
                                : `$${cell.toFixed(4)}`
                            }`
                          : ""
                      }
                      className={`w-7 h-7 ${
                        cell > 0
                          ? "cursor-pointer hover:ring-1 hover:ring-emerald-400/60"
                          : ""
                      } ${
                        cellSessions?.some((s) => s.id === selectedId)
                          ? "ring-1 ring-emerald-300"
                          : ""
                      }`}
                      style={{
                        backgroundColor: intensityColor(intensity, cell > 0),
                      }}
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ScaleBar mode={mode} max={max} />
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[11px] font-mono tracking-wide cursor-pointer transition-colors ${
        active
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-zinc-900/60 text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {label}
    </button>
  )
}

function ScaleBar({ mode, max }: { mode: Mode; max: number }) {
  if (max <= 0) return null
  const labelMin = mode === "cost" ? "$0" : "0"
  const labelMax = mode === "cost" ? `$${max.toFixed(4)}` : String(max)
  return (
    <div className="flex items-center gap-2 mt-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
      <span>{labelMin}</span>
      <div
        className="h-2 w-32 border border-zinc-800"
        style={{
          background:
            "linear-gradient(to right, rgb(39 39 42), rgb(16 185 129))",
        }}
      />
      <span>{labelMax}</span>
    </div>
  )
}

interface BucketResult {
  agents: string[]
  /** key = `${agent}|${hour}` ⇒ value */
  grid: Map<string, number>
  max: number
  perCellSessions: Map<string, SessionSummary[]>
}

function bucketize(sessions: SessionSummary[], mode: Mode): BucketResult {
  const grid = new Map<string, number>()
  const perCellSessions = new Map<string, SessionSummary[]>()
  const agentSet = new Set<string>()

  for (const s of sessions) {
    const agent = s.agent_name || "(unknown agent)"
    agentSet.add(agent)
    const hour = new Date(s.started_at).getHours()
    const key = `${agent}|${hour}`
    const prev = grid.get(key) ?? 0
    const incr = mode === "cost" ? s.total_cost_usd : 1
    grid.set(key, prev + incr)
    const list = perCellSessions.get(key) ?? []
    list.push(s)
    perCellSessions.set(key, list)
  }

  const max = Array.from(grid.values()).reduce((a, b) => Math.max(a, b), 0)
  const agents = Array.from(agentSet).sort((a, b) => a.localeCompare(b))

  return { agents, grid, max, perCellSessions }
}

function intensityColor(intensity: number, hasData: boolean): string {
  if (!hasData) return "rgb(24 24 27)" // zinc-900
  // Quantize to 5 buckets so the eye reads a discrete palette instead
  // of a smooth gradient that's harder to compare across cells.
  const bucket = Math.min(4, Math.floor(intensity * 5))
  // Tailwind emerald-{600,500,400,300,200} with progressive saturation,
  // chosen so even bucket 0 (the lowest non-zero value) is clearly
  // distinguishable from an empty cell.
  const colors = [
    "rgba(16, 185, 129, 0.20)",
    "rgba(16, 185, 129, 0.40)",
    "rgba(16, 185, 129, 0.60)",
    "rgba(16, 185, 129, 0.80)",
    "rgba(16, 185, 129, 1.00)",
  ]
  return colors[bucket]
}
