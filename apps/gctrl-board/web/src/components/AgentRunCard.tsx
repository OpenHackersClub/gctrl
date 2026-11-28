import type { AgentRun } from "../types"
import { type AgentColumn, cardGoal, cardHeadline, cardProgress, formatUsage, relativeTime } from "../lib/agent-lanes"

const HARNESS_MARK: Record<AgentRun["harness"], { label: string; className: string; title: string }> = {
  "claude-code": {
    label: "CC",
    className: "bg-orange-500/10 text-orange-300 border-orange-500/25",
    title: "Claude Code",
  },
  codex: {
    label: "CX",
    className: "bg-sky-500/10 text-sky-300 border-sky-500/25",
    title: "Codex",
  },
  hermes: {
    label: "HM",
    className: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/25",
    title: "Hermes Agent",
  },
  pi: {
    label: "PI",
    className: "bg-teal-500/10 text-teal-300 border-teal-500/25",
    title: "Pi",
  },
}

/** Left-border accent per column — same palette family as the issue board. */
const COLUMN_BORDER: Record<AgentColumn, string> = {
  needs_you: "border-l-rose-500",
  running: "border-l-amber-400",
  idle: "border-l-emerald-400",
  resumable: "border-l-zinc-600",
  done: "border-l-zinc-800",
}

const COLUMN_DOT: Record<AgentColumn, string> = {
  needs_you: "bg-rose-500 animate-pulse",
  running: "bg-amber-400 animate-pulse",
  idle: "bg-emerald-400",
  resumable: "border border-zinc-500",
  done: "bg-zinc-700",
}

interface Props {
  run: AgentRun
  column: AgentColumn
  now: Date
  busy: boolean
  onOpen: (run: AgentRun) => void
  /** Select mode: a click toggles selection instead of opening. */
  selecting?: boolean
  selected?: boolean
  onSelect?: (run: AgentRun) => void
  /** A gather waits for this run's turn to end. */
  queued?: boolean
  /** Click shows the run's session map; the iTerm2 button opens the terminal. */
  onInspect?: (run: AgentRun) => void
  /** The run shown in the detail pane. */
  inspected?: boolean
}

const FALLBACK_MARK = { label: "??", className: "bg-zinc-800 text-zinc-400 border-zinc-700", title: "Agent" }

/** Session-map states worth a chip; `active` is the default and shows none. */
const STATUS_CHIP: Record<string, string> = {
  blocked: "bg-rose-500/10 text-rose-300 border-rose-500/25",
  handoff: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  done: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
}

export function AgentRunCard({
  run,
  column,
  now,
  busy,
  onOpen,
  selecting,
  selected,
  onSelect,
  queued,
  onInspect,
  inspected,
}: Props) {
  const harness = HARNESS_MARK[run.harness] ?? FALLBACK_MARK
  const usage = formatUsage(run)
  const headline = cardHeadline(run)
  const goal = cardGoal(run)
  const progress = cardProgress(run)
  const status = run.progress?.status ?? null
  // Claude keys transcripts by cwd: a removed worktree cannot be resumed.
  const blocked = run.live === null && !run.cwd_exists
  const terminalAction = run.live ? "Go to iTerm2" : "Resume in iTerm2"
  const action = selecting
    ? selected
      ? "Deselect"
      : "Select"
    : onInspect
      ? "Show session map"
      : terminalAction
  const disabled = selecting || onInspect ? false : blocked || busy
  const activate = () => {
    if (selecting) onSelect?.(run)
    else if (onInspect) onInspect(run)
    else if (!disabled) onOpen(run)
  }
  const tooltip = [
    run.goal ? `Goal: ${run.goal}` : null,
    run.progress?.summary ? `Now: ${run.progress.summary}` : null,
    run.last_prompt ? `Last prompt: ${run.last_prompt}` : null,
    run.cwd,
    run.resume_command ?? (blocked ? "worktree removed" : null),
  ]
    .filter(Boolean)
    .join("\n")

  return (
    // A div with button semantics: the card holds a PR link, and a link
    // inside a <button> is invalid HTML.
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          activate()
        }
      }}
      title={tooltip}
      data-testid={`agent-card-${run.id}`}
      aria-label={`${action}: ${headline}`}
      aria-pressed={selecting ? Boolean(selected) : undefined}
      className={`w-full text-left group border-l-2 ${COLUMN_BORDER[column]}
        bg-zinc-900/80 border transition-all duration-100
        ${selected || inspected ? "border-emerald-500/70 ring-1 ring-emerald-500/40" : "border-zinc-800/80"}
        ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-zinc-700 hover:bg-zinc-900"}
        ${busy ? "animate-pulse" : ""}`}
    >
      <div className="px-3 py-2.5 space-y-1.5">
        {/* Top row: state dot, harness, name, worktree */}
        <div className="flex items-center gap-1.5 min-w-0">
          {selecting && (
            <input
              type="checkbox"
              readOnly
              tabIndex={-1}
              checked={Boolean(selected)}
              data-testid={`agent-select-${run.id}`}
              className="accent-emerald-500 shrink-0 pointer-events-none"
            />
          )}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${COLUMN_DOT[column]}`} />
          <span
            title={harness.title}
            className={`text-[9px] font-mono font-semibold tracking-widest px-1 py-px border shrink-0 ${harness.className}`}
          >
            {harness.label}
          </span>
          <span className="font-mono text-[12px] text-zinc-200 truncate">{headline}</span>
          {run.worktree && (
            <span className="font-mono text-[11px] text-zinc-500 shrink-0">[/{run.worktree}]</span>
          )}
        </div>

        {/* Goal: what the run is working toward */}
        {goal && (
          <p className="text-[12.5px] text-zinc-200 leading-snug line-clamp-2" data-testid="agent-goal">
            {goal}
          </p>
        )}

        {/* Where the work stands: current step or summary, step count */}
        {(progress || (status && STATUS_CHIP[status])) && (
          <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-zinc-400" data-testid="agent-progress">
            {status && STATUS_CHIP[status] && (
              <span className={`text-[9px] font-mono uppercase tracking-wider px-1 py-px border shrink-0 ${STATUS_CHIP[status]}`}>
                {status}
              </span>
            )}
            {progress && (
              <span className="truncate">
                <span className="opacity-50 mr-1">▸</span>
                {progress}
              </span>
            )}
          </div>
        )}

        {/* Bottom row: branch, time, usage, PR */}
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono text-zinc-500">
          {run.git_branch && !run.worktree && <span className="truncate max-w-[9rem]">{run.git_branch}</span>}
          <span>{relativeTime(run.updated_at, now)}</span>
          {usage && <span className="text-zinc-400">{usage}</span>}
          {run.pr && (
            <a
              href={run.pr.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="px-1.5 py-px bg-violet-500/10 text-violet-300 border border-violet-500/20 hover:bg-violet-500/20"
            >
              #{run.pr.number}
            </a>
          )}
          {blocked && (
            <span className="px-1.5 py-px bg-zinc-800 text-zinc-500 border border-zinc-700">worktree removed</span>
          )}
          {queued && (
            <span
              className="px-1.5 py-px bg-amber-500/10 text-amber-300 border border-amber-500/25"
              title="Moves to the gather window when this turn ends"
            >
              waiting to move
            </span>
          )}
          {!selecting && (
            <button
              type="button"
              data-testid={`agent-iterm-${run.id}`}
              disabled={blocked || busy}
              onClick={(e) => {
                e.stopPropagation()
                onOpen(run)
              }}
              onKeyDown={(e) => e.stopPropagation()}
              title={run.resume_command ?? terminalAction}
              aria-label={`${terminalAction}: ${headline}`}
              className="ml-auto px-1.5 py-px border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/50
                opacity-70 group-hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              iTerm2 ↗
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
