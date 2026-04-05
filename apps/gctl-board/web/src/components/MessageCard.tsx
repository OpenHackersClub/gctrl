import type { InboxMessage } from "../types"

const URGENCY_DOT: Record<string, string> = {
  urgent: "#f43f5e",
  high: "#f97316",
  medium: "#fbbf24",
  low: "#38bdf8",
}

const KIND_LABEL: Record<string, string> = {
  permission_request: "Permission",
  budget_warning: "Budget",
  agent_question: "Question",
  status_update: "Status",
  error_report: "Error",
  review_request: "Review",
}

interface Props {
  message: InboxMessage
  selected: boolean
  onClick: () => void
}

export function MessageCard({ message, selected, onClick }: Props) {
  const urgencyColor = URGENCY_DOT[message.urgency] ?? URGENCY_DOT.low

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 border transition-all duration-100 cursor-pointer ${
        selected
          ? "bg-emerald-500/8 border-emerald-500/30"
          : "bg-zinc-900/60 border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900"
      }`}
    >
      {/* Top row: urgency dot + title + time */}
      <div className="flex items-start gap-2">
        <span
          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
          style={{ backgroundColor: urgencyColor }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={`text-[13px] leading-snug line-clamp-1 font-medium ${
              message.status === "unread" ? "text-zinc-100" : "text-zinc-400"
            }`}>
              {message.title}
            </p>
            {message.requires_action && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
                title="Requires action"
              />
            )}
          </div>

          {/* Second row: source + kind badge + time */}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] font-mono text-zinc-500 truncate">
              {message.source_name}
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800/80 text-zinc-500 border border-zinc-700/40 leading-none">
              {KIND_LABEL[message.kind] ?? message.kind}
            </span>
            <span className="text-[10px] font-mono text-zinc-600 ml-auto shrink-0">
              {formatTimeAgo(message.created_at)}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}

function formatTimeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffSec = Math.floor((now - then) / 1000)

  if (diffSec < 60) return "now"
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`
  return new Date(iso).toLocaleDateString()
}
