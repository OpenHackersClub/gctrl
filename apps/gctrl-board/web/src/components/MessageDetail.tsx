import { useState } from "react"
import type { InboxMessage } from "../types"

const URGENCY_DOT: Record<string, string> = {
  urgent: "#f43f5e",
  high: "#f97316",
  medium: "#fbbf24",
  low: "#38bdf8",
}

const URGENCY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
}

const KIND_LABEL: Record<string, string> = {
  permission_request: "Permission Request",
  budget_warning: "Budget Warning",
  agent_question: "Agent Question",
  status_update: "Status Update",
  error_report: "Error Report",
  review_request: "Review Request",
}

interface Props {
  message: InboxMessage
  onAction: (actionType: string, reason?: string) => Promise<void>
}

export function MessageDetail({ message, onAction }: Props) {
  const [acting, setActing] = useState<string | null>(null)
  const [contextOpen, setContextOpen] = useState(false)

  const urgencyColor = URGENCY_DOT[message.urgency] ?? URGENCY_DOT.low

  const handleAction = async (actionType: string) => {
    if (acting) return
    setActing(actionType)
    try {
      await onAction(actionType)
    } finally {
      setActing(null)
    }
  }

  const contextEntries = message.context ? Object.entries(message.context) : []

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="px-5 py-4 border-b border-zinc-800/50 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: urgencyColor }}
          />
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
            {URGENCY_LABEL[message.urgency] ?? message.urgency}
          </span>
          <span className="text-zinc-800">|</span>
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
            {KIND_LABEL[message.kind] ?? message.kind}
          </span>
          {message.requires_action && (
            <>
              <span className="text-zinc-800">|</span>
              <span className="text-[10px] font-mono text-emerald-400/80 uppercase tracking-wider">
                Action Required
              </span>
            </>
          )}
        </div>
        <h2 className="text-lg font-display font-semibold text-zinc-100 leading-snug">
          {message.title}
        </h2>
        <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-500 font-mono">
          <span>from {message.source_name}</span>
          <span className="text-zinc-700">{message.source_type}</span>
          <span className="ml-auto text-zinc-600">
            {new Date(message.created_at).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-4">
          {/* Message body */}
          <div>
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {message.body}
            </p>
          </div>

          {/* Context section */}
          {contextEntries.length > 0 && (
            <div className="border border-zinc-800/50">
              <button
                type="button"
                onClick={() => setContextOpen(!contextOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-wider hover:text-zinc-400 transition-colors cursor-pointer"
              >
                <span>Context ({contextEntries.length} fields)</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${contextOpen ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="square" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {contextOpen && (
                <div className="border-t border-zinc-800/50 px-3 py-2 space-y-1.5">
                  {contextEntries.map(([key, value]) => (
                    <div key={key} className="flex items-start gap-3">
                      <span className="text-[11px] font-mono text-zinc-600 shrink-0 w-32 truncate">
                        {key}
                      </span>
                      <span className="text-[11px] font-mono text-zinc-400 break-all">
                        {typeof value === "object" ? JSON.stringify(value) : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Thread ID reference */}
          {message.thread_id && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">Thread</span>
              <span className="text-xs font-mono text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 border border-emerald-500/20">
                {message.thread_id}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="px-5 py-3 border-t border-zinc-800/50 flex items-center gap-2 shrink-0">
        <ActionButton
          label="Approve"
          actionType="approve"
          acting={acting}
          onClick={handleAction}
          className="bg-emerald-500/10 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20"
        />
        <ActionButton
          label="Reject"
          actionType="reject"
          acting={acting}
          onClick={handleAction}
          className="bg-rose-500/10 text-rose-400 border-rose-500/25 hover:bg-rose-500/20"
        />
        <ActionButton
          label="Acknowledge"
          actionType="acknowledge"
          acting={acting}
          onClick={handleAction}
          className="bg-zinc-500/10 text-zinc-400 border-zinc-500/25 hover:bg-zinc-500/20"
        />
        <ActionButton
          label="Snooze"
          actionType="snooze"
          acting={acting}
          onClick={handleAction}
          className="bg-amber-500/10 text-amber-400 border-amber-500/25 hover:bg-amber-500/20"
        />
      </div>
    </div>
  )
}

function ActionButton({
  label,
  actionType,
  acting,
  onClick,
  className,
}: {
  label: string
  actionType: string
  acting: string | null
  onClick: (actionType: string) => void
  className: string
}) {
  const isActive = acting === actionType
  const isDisabled = acting !== null

  return (
    <button
      type="button"
      onClick={() => onClick(actionType)}
      disabled={isDisabled}
      className={`px-3 py-1.5 text-[13px] font-display font-medium tracking-wide border transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${className}`}
    >
      {isActive ? `${label.toUpperCase()}...` : label.toUpperCase()}
    </button>
  )
}
