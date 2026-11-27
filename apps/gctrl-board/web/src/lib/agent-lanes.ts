import type { AgentOpenResult, AgentRun, InboxMessage } from "../types"

/** Board columns, most urgent first. Spec: agent-panel.md § States. */
export type AgentColumn = "needs_you" | "running" | "idle" | "resumable" | "done"

export const AGENT_COLUMNS: readonly AgentColumn[] = [
  "needs_you",
  "running",
  "idle",
  "resumable",
  "done",
]

export const AGENT_COLUMN_LABELS: Record<AgentColumn, string> = {
  needs_you: "Needs you",
  running: "Running",
  idle: "Idle",
  resumable: "Resumable",
  done: "Done",
}

const COLUMN_RANK: Record<AgentColumn, number> = {
  needs_you: 0,
  running: 1,
  idle: 2,
  resumable: 3,
  done: 4,
}

export interface AgentLane {
  projectKey: string
  columns: Record<AgentColumn, AgentRun[]>
  counts: Record<AgentColumn, number>
  /** Rank of the most urgent non-empty column. */
  urgency: number
  /** Latest `updated_at` across the lane's runs. */
  latestUpdate: string
  /** True when any run in the lane has a live process. */
  live: boolean
}

/**
 * Session ids with an open request for the operator: a pending inbox message
 * with `requires_action`, not yet expired, whose `context.session_id` names
 * the harness session.
 */
export function needsYouSessionIds(messages: InboxMessage[], now: Date): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.status !== "pending" || !m.requires_action) continue
    if (m.expires_at && Date.parse(m.expires_at) <= now.getTime()) continue
    const sessionId = m.context.session_id
    if (typeof sessionId === "string" && sessionId.length > 0) ids.add(sessionId)
  }
  return ids
}

/**
 * Column for one run. A request in the inbox only counts while the run's
 * process is live — a dead process cannot answer a prompt.
 */
export function columnFor(run: AgentRun, needsYou: ReadonlySet<string>): AgentColumn {
  if (run.state === "done") return "done"
  const isLive = run.state === "running" || run.state === "idle"
  if (isLive && needsYou.has(run.native_id)) return "needs_you"
  return run.state
}

const emptyColumns = (): Record<AgentColumn, AgentRun[]> => ({
  needs_you: [],
  running: [],
  idle: [],
  resumable: [],
  done: [],
})

const byUpdatedDesc = (a: AgentRun, b: AgentRun) => b.updated_at.localeCompare(a.updated_at)

/**
 * One lane per `project_key`. Cards sort newest first; lanes sort by their
 * most urgent column, then by latest activity, then by key.
 */
export function buildLanes(runs: AgentRun[], needsYou: ReadonlySet<string>): AgentLane[] {
  const byProject = new Map<string, AgentRun[]>()
  for (const r of runs) {
    const bucket = byProject.get(r.project_key)
    if (bucket) bucket.push(r)
    else byProject.set(r.project_key, [r])
  }

  const lanes: AgentLane[] = []
  for (const [projectKey, projectRuns] of byProject) {
    const columns = emptyColumns()
    for (const r of projectRuns) columns[columnFor(r, needsYou)].push(r)
    for (const col of AGENT_COLUMNS) columns[col].sort(byUpdatedDesc)

    const counts = {
      needs_you: columns.needs_you.length,
      running: columns.running.length,
      idle: columns.idle.length,
      resumable: columns.resumable.length,
      done: columns.done.length,
    }
    const firstNonEmpty = AGENT_COLUMNS.find((c) => counts[c] > 0)
    lanes.push({
      projectKey,
      columns,
      counts,
      urgency: firstNonEmpty ? COLUMN_RANK[firstNonEmpty] : AGENT_COLUMNS.length,
      latestUpdate: projectRuns.reduce(
        (max, r) => (r.updated_at > max ? r.updated_at : max),
        "",
      ),
      live: projectRuns.some((r) => r.live !== null),
    })
  }

  return lanes.sort(
    (a, b) =>
      a.urgency - b.urgency ||
      b.latestUpdate.localeCompare(a.latestUpdate) ||
      a.projectKey.localeCompare(b.projectKey),
  )
}

/** One-line summary for a collapsed lane. */
export function laneSummary(lane: AgentLane, now: Date): string {
  const parts = AGENT_COLUMNS.filter((c) => lane.counts[c] > 0).map(
    (c) => `${lane.counts[c]} ${AGENT_COLUMN_LABELS[c].toLowerCase()}`,
  )
  if (lane.latestUpdate) parts.push(`last active ${relativeTime(lane.latestUpdate, now)}`)
  return parts.join(" · ")
}

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Card headline: the `/rename` or thread name, else the title. */
export function cardHeadline(run: AgentRun): string {
  return run.name ?? run.title
}

export function formatUsage(run: AgentRun): string | null {
  if (run.cost_usd !== null) return `$${run.cost_usd.toFixed(2)}`
  if (run.tokens !== null) {
    if (run.tokens >= 1_000_000) return `${(run.tokens / 1_000_000).toFixed(1)}M tok`
    if (run.tokens >= 1_000) return `${(run.tokens / 1_000).toFixed(1)}k tok`
    return `${run.tokens} tok`
  }
  return null
}

export interface OpenToast {
  message: string
  type: "success" | "error"
}

/** Toast copy for a `POST /api/agents/{id}/open` result. */
export function openResultMessage(result: AgentOpenResult): OpenToast {
  const dryRun = result.action.startsWith("would_")
  const action = dryRun ? result.action.slice("would_".length) : result.action
  if (dryRun) {
    const what =
      action.startsWith("launch") && result.command
        ? `launch \`${result.command}\``
        : action.startsWith("focus")
          ? `focus ${result.detail ?? "the pane"}`
          : (result.detail ?? "do nothing")
    return { message: `Dry run: would ${what}`, type: "success" }
  }
  switch (action) {
    case "focused":
      return { message: `Focused ${result.detail ?? "terminal"}`, type: "success" }
    case "launched":
      return { message: "Resumed in a new iTerm2 tab", type: "success" }
    default:
      return { message: "Live, but its terminal pane was not found", type: "error" }
  }
}

/** Toast copy for a failed open call (`request` throws `"<status>: <body>"`). */
export function openErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.startsWith("409")) return "Worktree removed — cannot resume here"
  if (text.startsWith("403")) return "Automation denied — allow gctrl to control iTerm2 in System Settings"
  if (text.startsWith("404")) return "Run no longer exists"
  return `Open failed: ${text}`
}
