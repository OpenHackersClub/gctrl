import { useState, useCallback } from "react"
import { useInbox } from "../hooks/useInbox"
import { MessageCard } from "../components/MessageCard"
import { MessageDetail } from "../components/MessageDetail"
import type { InboxMessage } from "../types"

const URGENCY_OPTIONS = [
  { value: "", label: "All urgency" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
]

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  { value: "permission_request", label: "Permission Request" },
  { value: "budget_warning", label: "Budget Warning" },
  { value: "agent_question", label: "Agent Question" },
  { value: "status_update", label: "Status Update" },
  { value: "error_report", label: "Error Report" },
  { value: "review_request", label: "Review Request" },
]

const STATUS_OPTIONS = [
  { value: "", label: "All status" },
  { value: "unread", label: "Unread" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
]

export function InboxPage() {
  const [urgencyFilter, setUrgencyFilter] = useState("")
  const [kindFilter, setKindFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filters = {
    urgency: urgencyFilter || undefined,
    kind: kindFilter || undefined,
    status: statusFilter || undefined,
  }

  const { messages, stats, loading, createAction } = useInbox(filters)

  const selectedMessage = messages.find((m) => m.id === selectedId) ?? null

  const handleSelectMessage = useCallback((msg: InboxMessage) => {
    setSelectedId(msg.id)
  }, [])

  const handleAction = useCallback(
    async (actionType: string, reason?: string) => {
      if (!selectedMessage) return
      await createAction(selectedMessage.id, actionType, reason)
    },
    [selectedMessage, createAction]
  )

  const unreadCount = stats?.unread ?? 0
  const actionCount = stats?.requires_action ?? 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-5 py-3 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="font-display font-semibold text-[15px] tracking-wider text-zinc-100 uppercase">
              Inbox
            </h1>
            {stats && (
              <span className="text-xs font-mono text-zinc-500 tracking-wide">
                {unreadCount > 0 && (
                  <span className="text-zinc-400">{unreadCount} unread</span>
                )}
                {unreadCount > 0 && actionCount > 0 && (
                  <span className="text-zinc-700"> {"\u00b7"} </span>
                )}
                {actionCount > 0 && (
                  <span className="text-amber-400/80">{actionCount} require action</span>
                )}
                {unreadCount === 0 && actionCount === 0 && (
                  <span className="text-zinc-600">all clear</span>
                )}
              </span>
            )}
          </div>
          <span className="text-xs font-mono text-zinc-600">
            {messages.length} message{messages.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2">
          <FilterSelect
            options={URGENCY_OPTIONS}
            value={urgencyFilter}
            onChange={setUrgencyFilter}
          />
          <FilterSelect
            options={KIND_OPTIONS}
            value={kindFilter}
            onChange={setKindFilter}
          />
          <FilterSelect
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
          />
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel: message list */}
        <div className="w-80 shrink-0 border-r border-zinc-800/60 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-3 p-5">
              <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
              <span className="text-sm text-zinc-400 font-mono">Loading messages...</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="p-5 text-center">
              <div className="text-sm text-zinc-500 font-mono">No messages</div>
              <div className="text-xs text-zinc-600 mt-1">
                {urgencyFilter || kindFilter || statusFilter
                  ? "Try adjusting your filters"
                  : "Inbox is empty"}
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              {messages.map((msg) => (
                <MessageCard
                  key={msg.id}
                  message={msg}
                  selected={msg.id === selectedId}
                  onClick={() => handleSelectMessage(msg)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right panel: message detail */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {selectedMessage ? (
            <MessageDetail
              message={selectedMessage}
              onAction={handleAction}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <div className="text-zinc-700">
                  <svg className="w-10 h-10 mx-auto" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v1.2l-8 4.8-8-4.8V5z" />
                    <path d="M2 8.2l8 4.8 8-4.8V15a2 2 0 01-2 2H4a2 2 0 01-2-2V8.2z" />
                  </svg>
                </div>
                <p className="text-sm font-mono text-zinc-600">
                  Select a message to view details
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-1 text-[12px] font-mono bg-zinc-900 border border-zinc-800 text-zinc-400 focus:border-emerald-500/40 focus:outline-none appearance-none cursor-pointer hover:border-zinc-700 transition-colors"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
