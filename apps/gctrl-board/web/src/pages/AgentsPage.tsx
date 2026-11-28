import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api/client"
import { AgentDetailPane } from "../components/AgentDetailPane"
import { AgentRunCard } from "../components/AgentRunCard"
import { GatherDialog } from "../components/GatherDialog"
import { ProjectFilter } from "../components/ProjectFilter"
import { useAgents } from "../hooks/useAgents"
import {
  AGENT_COLUMNS,
  AGENT_COLUMN_LABELS,
  type AgentColumn,
  type AgentLane,
  buildLanes,
  columnFor,
  gatherErrorMessage,
  gatherResultMessage,
  laneSummary,
  projectOptions,
  visibleLanes,
  needsYouSessionIds,
  openErrorMessage,
  openResultMessage,
} from "../lib/agent-lanes"
import type { AgentRun } from "../types"

const COLUMN_ACCENT: Record<AgentColumn, string> = {
  needs_you: "#f43f5e",
  running: "#f59e0b",
  idle: "#34d399",
  resumable: "#71717a",
  done: "#3f3f46",
}

interface Props {
  onToast: (message: string, type?: "error" | "success") => void
}

/** Projects the operator hid from the board; a new project shows by default. */
const HIDDEN_PROJECTS_KEY = "gctrl.agents.hiddenProjects"

function loadHiddenProjects(): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(HIDDEN_PROJECTS_KEY) : null
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * Every coding-agent run on this machine (Claude Code, Codex, Hermes, Pi):
 * state columns × project swimlanes. Spec:
 * vault/specs/architecture/apps/agent-panel.md § Board page.
 */
export function AgentsPage({ onToast }: Props) {
  const [includeHeadless, setIncludeHeadless] = useState(false)
  const [includeStale, setIncludeStale] = useState(false)
  const [showDone, setShowDone] = useState(false)
  // Lanes the operator toggled away from their default (live ⇒ open).
  const [toggledLanes, setToggledLanes] = useState<ReadonlySet<string>>(new Set())
  const [opening, setOpening] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [gatherOpen, setGatherOpen] = useState(false)
  const [gathering, setGathering] = useState(false)
  const [inspectedId, setInspectedId] = useState<string | null>(null)

  const { data, messages, loading, error, refresh } = useAgents({ includeHeadless, includeStale })

  const now = new Date()
  const nowMinute = Math.floor(now.getTime() / 60_000)
  const needsYou = useMemo(
    () => needsYouSessionIds(messages, new Date(nowMinute * 60_000)),
    [messages, nowMinute],
  )
  const [hiddenProjects, setHiddenProjects] = useState<ReadonlySet<string>>(loadHiddenProjects)
  useEffect(() => {
    try {
      window.localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...hiddenProjects]))
    } catch {
      // Storage unavailable (private mode): the filter lasts for this visit.
    }
  }, [hiddenProjects])
  const allLanes = useMemo(() => buildLanes(data?.runs ?? [], needsYou), [data, needsYou])
  const projects = useMemo(() => projectOptions(allLanes), [allLanes])
  const lanes = useMemo(() => visibleLanes(allLanes, hiddenProjects), [allLanes, hiddenProjects])

  const toggleLane = useCallback((key: string) => {
    setToggledLanes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleOpen = useCallback(
    async (run: AgentRun) => {
      setOpening(run.id)
      try {
        const result = await api.agents.open(run.id)
        const toast = openResultMessage(result)
        onToast(toast.message, toast.type)
        refresh()
      } catch (e) {
        onToast(openErrorMessage(e), "error")
      } finally {
        setOpening(null)
      }
    },
    [onToast, refresh],
  )

  const toggleSelected = useCallback((run: AgentRun) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(run.id)) next.delete(run.id)
      else next.add(run.id)
      return next
    })
  }, [])

  const exitSelect = useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
    setGatherOpen(false)
  }, [])

  const selectedRuns = useMemo(
    () => (data?.runs ?? []).filter((r) => selected.has(r.id)),
    [data, selected],
  )
  const queued = useMemo(() => new Set(data?.gather_queue ?? []), [data])
  const inspected = useMemo(
    () => (inspectedId ? (data?.runs ?? []).find((r) => r.id === inspectedId) ?? null : null),
    [data, inspectedId],
  )
  const inspect = useCallback((run: AgentRun) => setInspectedId((cur) => (cur === run.id ? null : run.id)), [])

  const handleGather = useCallback(
    async ({ spaceId, closeOld }: { spaceId: number | null; closeOld: boolean }) => {
      setGathering(true)
      try {
        if (spaceId !== null) {
          try {
            await api.macos.switchTo(spaceId)
          } catch (e) {
            onToast(gatherErrorMessage(e, "switch"), "error")
            return
          }
          // Let the Space transition finish so the window opens on the target.
          await new Promise((r) => setTimeout(r, 600))
        }
        const result = await api.agents.gather([...selected], { closeOld })
        const toast = gatherResultMessage(result)
        onToast(toast.message, toast.type)
        exitSelect()
        refresh()
      } catch (e) {
        onToast(gatherErrorMessage(e, "gather"), "error")
      } finally {
        setGathering(false)
      }
    },
    [selected, onToast, exitSelect, refresh],
  )

  const totals = useMemo(() => {
    const counts: Record<AgentColumn, number> = { needs_you: 0, running: 0, idle: 0, resumable: 0, done: 0 }
    for (const r of data?.runs ?? []) {
      if (!hiddenProjects.has(r.project_key)) counts[columnFor(r, needsYou)] += 1
    }
    return counts
  }, [data, needsYou, hiddenProjects])
  const visibleRuns = AGENT_COLUMNS.reduce((n, c) => n + totals[c], 0)

  const gridTemplate = `repeat(4, minmax(220px, 1fr)) ${showDone ? "minmax(220px, 1fr)" : "7rem"}`

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] min-w-0" data-testid="agents-page">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800/80 text-[11px] font-mono">
        <FilterToggle
          label="Show headless"
          checked={includeHeadless}
          onChange={setIncludeHeadless}
          testId="toggle-headless"
        />
        <FilterToggle
          label="Show stale (7d+)"
          checked={includeStale}
          onChange={setIncludeStale}
          testId="toggle-stale"
        />
        {data && (data.hidden.headless > 0 || data.hidden.stale > 0) && (
          <span className="text-zinc-600">
            hidden: {data.hidden.headless} headless · {data.hidden.stale} stale
          </span>
        )}
        <span className="ml-auto text-zinc-500">
          {data
            ? hiddenProjects.size > 0
              ? `${visibleRuns} of ${data.runs.length} runs · ${lanes.length} of ${allLanes.length} projects`
              : `${data.runs.length} runs · ${allLanes.length} projects`
            : ""}
        </span>
        <ProjectFilter options={projects} hidden={hiddenProjects} onChange={setHiddenProjects} />
        {selecting ? (
          <>
            <button
              type="button"
              data-testid="gather-open"
              disabled={selected.size === 0}
              onClick={() => setGatherOpen(true)}
              className="px-2 py-1 bg-emerald-600/80 text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              Gather {selected.size} into a Space…
            </button>
            <button
              type="button"
              onClick={exitSelect}
              className="px-2 py-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="agents-select"
            onClick={() => setSelecting(true)}
            title="Select runs to gather into one iTerm2 window on a Space"
            className="px-2 py-1 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 cursor-pointer"
          >
            Select
          </button>
        )}
        {error && (
          <span className="text-rose-400" title={error}>
            kernel unreachable — showing last result
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 pb-6">
        {/* ── Column headers ── */}
        <div
          className="grid gap-3 sticky top-0 z-10 bg-zinc-950/95 backdrop-blur-sm pt-3 pb-2"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {AGENT_COLUMNS.map((col) => (
            <div
              key={col}
              data-testid={`agents-column-${col}`}
              className="flex items-center gap-2 px-2 py-1.5"
              style={{ borderTop: `2px solid ${COLUMN_ACCENT[col]}` }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: COLUMN_ACCENT[col] }} />
              <span className="text-xs font-display font-semibold tracking-wider text-zinc-400 uppercase">
                {AGENT_COLUMN_LABELS[col]}
              </span>
              <span className="text-[10px] font-mono text-zinc-600 ml-auto">{totals[col]}</span>
              {col === "done" && (
                <button
                  type="button"
                  onClick={() => setShowDone((v) => !v)}
                  className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  title={showDone ? "Collapse Done" : "Expand Done"}
                >
                  {showDone ? "◂" : "▸"}
                </button>
              )}
            </div>
          ))}
        </div>

        {loading && !data ? (
          <p className="text-[13px] font-mono text-zinc-600 px-2 py-8">loading runs…</p>
        ) : lanes.length === 0 ? (
          <p className="text-[13px] font-mono text-zinc-600 px-2 py-8">
            {error
              ? `Cannot reach /api/agents: ${error}`
              : hiddenProjects.size > 0 && allLanes.length > 0
                ? "Every project with runs is hidden — open Projects to show some."
                : "No runs match the filters."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {lanes.map((lane) => {
              const expanded = lane.live !== toggledLanes.has(lane.projectKey)
              return (
                <Lane
                  key={lane.projectKey}
                  lane={lane}
                  expanded={expanded}
                  showDone={showDone}
                  gridTemplate={gridTemplate}
                  now={now}
                  opening={opening}
                  onToggle={toggleLane}
                  onOpen={handleOpen}
                  selecting={selecting}
                  selected={selected}
                  queued={queued}
                  onSelect={toggleSelected}
                  inspectedId={inspectedId}
                  onInspect={inspect}
                />
              )
            })}
          </div>
        )}
      </div>
      {inspected && (
        <AgentDetailPane
          run={inspected}
          refreshKey={data?.generated_at ?? ""}
          now={now}
          busy={opening === inspected.id}
          onClose={() => setInspectedId(null)}
          onOpen={handleOpen}
          onToast={onToast}
        />
      )}
      {gatherOpen && (
        <GatherDialog
          runs={selectedRuns}
          busy={gathering}
          onClose={() => setGatherOpen(false)}
          onConfirm={handleGather}
        />
      )}
    </div>
  )
}

function Lane({
  lane,
  expanded,
  showDone,
  gridTemplate,
  now,
  opening,
  onToggle,
  onOpen,
  selecting,
  selected,
  queued,
  onSelect,
  inspectedId,
  onInspect,
}: {
  lane: AgentLane
  expanded: boolean
  showDone: boolean
  gridTemplate: string
  now: Date
  opening: string | null
  onToggle: (key: string) => void
  onOpen: (run: AgentRun) => void
  selecting: boolean
  selected: ReadonlySet<string>
  queued: ReadonlySet<string>
  onSelect: (run: AgentRun) => void
  inspectedId: string | null
  onInspect: (run: AgentRun) => void
}) {
  return (
    <section data-testid={`agents-lane-${lane.projectKey}`} className="border border-zinc-800/60 bg-zinc-950/40">
      <button
        type="button"
        onClick={() => onToggle(lane.projectKey)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer hover:bg-zinc-900/60"
      >
        <span className="text-[10px] font-mono text-zinc-500 w-3">{expanded ? "▾" : "▸"}</span>
        <span className="text-[13px] font-display font-semibold tracking-wide text-zinc-200">{lane.projectKey}</span>
        {lane.live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="live runs" />}
        {!expanded && <span className="text-[11px] font-mono text-zinc-500 truncate">{laneSummary(lane, now)}</span>}
      </button>

      {expanded && (
        <div className="grid gap-3 px-3 pb-3 pt-1" style={{ gridTemplateColumns: gridTemplate }}>
          {AGENT_COLUMNS.map((col) =>
            col === "done" && !showDone ? (
              <div key={col} className="text-[10px] font-mono text-zinc-600 px-2 pt-2">
                {lane.counts.done > 0 ? `${lane.counts.done} done` : ""}
              </div>
            ) : (
              <div key={col} className="flex flex-col gap-2 min-w-0">
                {lane.columns[col].map((run) => (
                  <AgentRunCard
                    key={run.id}
                    run={run}
                    column={col}
                    now={now}
                    busy={opening === run.id}
                    onOpen={onOpen}
                    selecting={selecting}
                    selected={selected.has(run.id)}
                    queued={queued.has(run.id)}
                    onSelect={onSelect}
                    inspected={inspectedId === run.id}
                    onInspect={onInspect}
                  />
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  )
}

function FilterToggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  testId: string
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none text-zinc-400 hover:text-zinc-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="accent-emerald-500"
      />
      {label}
    </label>
  )
}
