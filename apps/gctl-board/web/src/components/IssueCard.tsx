import type { Issue, Priority } from "../types"

const PRIORITY_COLORS: Record<Priority, string> = {
  urgent: "bg-rose-500",
  high: "bg-orange-500",
  medium: "bg-amber-400",
  low: "bg-sky-400",
  none: "bg-zinc-600",
}

const PRIORITY_BORDER: Record<Priority, string> = {
  urgent: "border-l-rose-500",
  high: "border-l-orange-500",
  medium: "border-l-amber-400",
  low: "border-l-sky-400",
  none: "border-l-zinc-700",
}

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "URG",
  high: "HI",
  medium: "MED",
  low: "LO",
  none: "",
}

interface Props {
  issue: Issue
  onClick?: () => void
  isOverlay?: boolean
  isDragging?: boolean
}

export function IssueCard({ issue, onClick, isOverlay, isDragging }: Props) {
  const priority = (issue.priority || "none") as Priority

  return (
    <div
      onClick={onClick}
      className={`
        group border-l-2 ${PRIORITY_BORDER[priority]}
        bg-zinc-900/80 border border-zinc-800/80
        hover:border-zinc-700 hover:bg-zinc-900
        transition-all duration-100 cursor-pointer
        ${isDragging ? "opacity-30 scale-[0.98]" : ""}
        ${isOverlay ? "shadow-2xl shadow-emerald-500/10 border-emerald-500/30 rotate-1" : ""}
      `}
    >
      <div className="px-3 py-2.5 space-y-1.5">
        {/* Top row: ID + Priority */}
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-zinc-500 tracking-wide">
            {issue.id}
          </span>
          {priority !== "none" && (
            <span
              className={`inline-flex items-center gap-1 text-[9px] font-mono font-semibold tracking-widest
                px-1.5 py-0.5 ${PRIORITY_COLORS[priority]}/15 text-${PRIORITY_COLORS[priority].replace("bg-", "")}`}
              style={{
                backgroundColor: `color-mix(in srgb, ${getComputedPriorityColor(priority)} 12%, transparent)`,
                color: getComputedPriorityColor(priority),
              }}
            >
              {PRIORITY_LABELS[priority]}
            </span>
          )}
        </div>

        {/* Title */}
        <p className="text-[13px] text-zinc-200 leading-snug line-clamp-2 font-medium">
          {issue.title}
        </p>

        {/* Bottom row: assignee, cost, labels */}
        <div className="flex items-center gap-2 flex-wrap">
          {issue.assignee_name && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 ${
                issue.assignee_type === "agent"
                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                  : "bg-amber-500/10 text-amber-300 border border-amber-500/20"
              }`}
            >
              <span className="opacity-60">{issue.assignee_type === "agent" ? ">" : "@"}</span>
              {issue.assignee_name}
            </span>
          )}

          {issue.total_cost_usd > 0 && (
            <span className="text-[10px] font-mono text-zinc-500">
              ${issue.total_cost_usd.toFixed(2)}
            </span>
          )}

          {issue.labels.map((label) => (
            <span
              key={label}
              className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 text-zinc-400 border border-zinc-700/50"
            >
              {label}
            </span>
          ))}

          {issue.github_issue_number && (
            <span className="text-[10px] font-mono text-zinc-500 ml-auto" title={issue.github_url}>
              GH#{issue.github_issue_number}
            </span>
          )}
          {!issue.github_issue_number && issue.pr_numbers.length > 0 && (
            <span className="text-[10px] font-mono text-violet-400/60 ml-auto">
              PR#{issue.pr_numbers[0]}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function getComputedPriorityColor(priority: Priority): string {
  const map: Record<Priority, string> = {
    urgent: "#f43f5e",
    high: "#f97316",
    medium: "#fbbf24",
    low: "#38bdf8",
    none: "#52525b",
  }
  return map[priority]
}
