import { useState, useEffect } from "react"
import type { Issue, Comment as IssueComment, IssueEvent, Priority } from "../types"
import { STATUS_LABELS } from "../types"
import { api } from "../api/client"

interface Props {
  issue: Issue
  onClose: () => void
  onUpdate: () => void
}

const PRIORITY_DOT: Record<Priority, string> = {
  urgent: "#f43f5e",
  high: "#f97316",
  medium: "#fbbf24",
  low: "#38bdf8",
  none: "#52525b",
}

const STATUS_COLOR: Record<string, string> = {
  backlog: "#52525b",
  todo: "#38bdf8",
  in_progress: "#f59e0b",
  in_review: "#a78bfa",
  done: "#34d399",
  cancelled: "#f43f5e",
}

export function IssueDetailPanel({ issue, onClose, onUpdate }: Props) {
  const [comments, setComments] = useState<IssueComment[]>([])
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [newComment, setNewComment] = useState("")
  const [tab, setTab] = useState<"details" | "comments" | "events">("details")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api.issues.comments(issue.id).then(setComments).catch(() => {})
    api.issues.events(issue.id).then(setEvents).catch(() => {})
  }, [issue.id])

  const handleAddComment = async () => {
    if (!newComment.trim() || submitting) return
    setSubmitting(true)
    try {
      await api.issues.addComment(issue.id, {
        author_id: "web-user",
        author_name: "Web UI",
        author_type: "human",
        body: newComment.trim(),
      })
      setNewComment("")
      const updated = await api.issues.comments(issue.id)
      setComments(updated)
      onUpdate()
    } catch {
      // parent handles errors
    } finally {
      setSubmitting(false)
    }
  }

  const priority = (issue.priority || "none") as Priority

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Panel */}
      <div data-testid="issue-detail-panel" className="fixed top-0 right-0 h-full w-full max-w-lg bg-zinc-950 border-l border-zinc-800 z-50 animate-slide-in-right flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-emerald-400/80">{issue.id}</span>
            <span
              className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 border"
              style={{
                borderColor: `${STATUS_COLOR[issue.status]}40`,
                color: STATUS_COLOR[issue.status],
                backgroundColor: `${STATUS_COLOR[issue.status]}10`,
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: STATUS_COLOR[issue.status] }}
              />
              {STATUS_LABELS[issue.status as keyof typeof STATUS_LABELS]}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="square" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Title */}
        <div className="px-5 py-4 border-b border-zinc-800/50 shrink-0">
          <h2 className="text-lg font-display font-semibold text-zinc-100 leading-snug">
            {issue.title}
          </h2>
        </div>

        {/* Properties grid */}
        <div className="px-5 py-3 border-b border-zinc-800/50 grid grid-cols-2 gap-y-2.5 gap-x-4 text-[13px] shrink-0">
          <Property label="Priority">
            <span className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: PRIORITY_DOT[priority] }}
              />
              <span className="capitalize">{priority}</span>
            </span>
          </Property>
          <Property label="Assignee">
            {issue.assignee_name ? (
              <span className="font-mono text-xs">
                <span className="text-zinc-500">{issue.assignee_type === "agent" ? "> " : "@ "}</span>
                {issue.assignee_name}
              </span>
            ) : (
              <span className="text-zinc-600">Unassigned</span>
            )}
          </Property>
          <Property label="Cost">
            <span className="font-mono">${issue.total_cost_usd.toFixed(2)}</span>
          </Property>
          <Property label="Tokens">
            <span className="font-mono">{issue.total_tokens.toLocaleString()}</span>
          </Property>
          {issue.session_ids.length > 0 && (
            <Property label="Sessions">
              <span className="font-mono">{issue.session_ids.length}</span>
            </Property>
          )}
          {issue.pr_numbers.length > 0 && (
            <Property label="PRs">
              <span className="font-mono text-violet-400">
                {issue.pr_numbers.map((n) => `#${n}`).join(", ")}
              </span>
            </Property>
          )}
          {issue.github_issue_number && (
            <Property label="GitHub">
              {issue.github_url ? (
                <a
                  href={issue.github_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-emerald-400/80 hover:text-emerald-300 transition-colors"
                >
                  #{issue.github_issue_number} ↗
                </a>
              ) : (
                <span className="font-mono text-zinc-400">#{issue.github_issue_number}</span>
              )}
            </Property>
          )}
          <Property label="Created">
            <span className="font-mono text-xs text-zinc-500">
              {new Date(issue.created_at).toLocaleDateString()}
            </span>
          </Property>
        </div>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <div className="px-5 py-2.5 border-b border-zinc-800/50 flex items-center gap-2 flex-wrap shrink-0">
            <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">Labels</span>
            {issue.labels.map((l) => (
              <span key={l} className="text-[11px] font-mono px-1.5 py-0.5 bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                {l}
              </span>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-zinc-800/50 px-5 shrink-0">
          {(["details", "comments", "events"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-display tracking-wider uppercase transition-colors cursor-pointer ${
                tab === t
                  ? "text-emerald-400 border-b-2 border-emerald-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t}
              {t === "comments" && comments.length > 0 && (
                <span className="ml-1.5 font-mono text-zinc-600">{comments.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === "details" && (
            <div className="p-5 space-y-4">
              {/* Description */}
              {issue.description && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1.5">
                    Description
                  </h4>
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                    {issue.description}
                  </p>
                </div>
              )}

              {/* Created by */}
              <div>
                <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1">
                  Created By
                </h4>
                <span className="text-sm font-mono text-zinc-400">
                  <span className="text-zinc-500">{issue.created_by_type === "agent" ? "> " : "@ "}</span>
                  {issue.created_by_name}
                </span>
              </div>

              {/* Parent issue */}
              {issue.parent_id && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1">
                    Parent Issue
                  </h4>
                  <span className="text-xs font-mono text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 border border-emerald-500/20">
                    {issue.parent_id}
                  </span>
                </div>
              )}

              {/* Linked sessions */}
              {issue.session_ids.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1.5">
                    Linked Sessions
                  </h4>
                  <div className="flex flex-col gap-1">
                    {issue.session_ids.map((sid) => (
                      <span key={sid} className="text-xs font-mono text-cyan-400/70 bg-cyan-500/10 px-1.5 py-0.5 border border-cyan-500/20 w-fit">
                        {sid}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Acceptance criteria */}
              {(issue.acceptance_criteria ?? []).length > 0 && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-2">
                    Acceptance Criteria
                  </h4>
                  <ul className="space-y-1">
                    {(issue.acceptance_criteria ?? []).map((c, i) => (
                      <li key={i} className="text-sm text-zinc-400 flex items-start gap-2">
                        <span className="text-zinc-600 font-mono text-xs mt-0.5">-</span>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Blocked by */}
              {issue.blocked_by.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1">
                    Blocked By
                  </h4>
                  <div className="flex gap-2 flex-wrap">
                    {issue.blocked_by.map((id) => (
                      <span key={id} className="text-xs font-mono text-rose-400/70 bg-rose-500/10 px-1.5 py-0.5 border border-rose-500/20">
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Blocking */}
              {issue.blocking.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider mb-1">
                    Blocking
                  </h4>
                  <div className="flex gap-2 flex-wrap">
                    {issue.blocking.map((id) => (
                      <span key={id} className="text-xs font-mono text-amber-400/70 bg-amber-500/10 px-1.5 py-0.5 border border-amber-500/20">
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state — only when truly nothing to show */}
              {!issue.description &&
                issue.session_ids.length === 0 &&
                !issue.parent_id &&
                (issue.acceptance_criteria ?? []).length === 0 &&
                issue.blocked_by.length === 0 &&
                issue.blocking.length === 0 && (
                  <div className="py-4 text-center text-sm text-zinc-600 font-mono">
                    No additional details
                  </div>
                )}
            </div>
          )}

          {tab === "comments" && (
            <div className="p-5 space-y-3">
              {comments.map((c) => (
                <div key={c.id} className="border border-zinc-800/50 bg-zinc-900/40 p-3 space-y-1.5">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-zinc-400">
                      {c.author_type === "agent" ? "> " : "@ "}
                      {c.author_name}
                    </span>
                    <span className="text-zinc-700">
                      {new Date(c.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{c.body}</p>
                </div>
              ))}
              {comments.length === 0 && (
                <div className="py-4 text-center text-sm text-zinc-600 font-mono">
                  No comments yet
                </div>
              )}

              {/* Add comment */}
              <div className="pt-2 space-y-2">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Add a comment..."
                  rows={3}
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 text-zinc-200
                    placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none resize-none"
                />
                <button
                  onClick={handleAddComment}
                  disabled={!newComment.trim() || submitting}
                  className="px-3 py-1.5 text-xs font-display tracking-wide
                    bg-emerald-500/10 text-emerald-400 border border-emerald-500/25
                    hover:bg-emerald-500/20 disabled:opacity-30 disabled:cursor-not-allowed
                    transition-colors cursor-pointer"
                >
                  {submitting ? "SENDING..." : "COMMENT"}
                </button>
              </div>
            </div>
          )}

          {tab === "events" && (
            <div className="p-5">
              {events.length === 0 ? (
                <div className="py-4 text-center text-sm text-zinc-600 font-mono">
                  No events recorded
                </div>
              ) : (
                <div className="space-y-0">
                  {events.map((ev, i) => (
                    <div key={ev.id} className="flex gap-3 py-2">
                      <div className="flex flex-col items-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 mt-1.5" />
                        {i < events.length - 1 && <div className="w-px flex-1 bg-zinc-800" />}
                      </div>
                      <div className="space-y-0.5 pb-2">
                        <div className="text-[12px] text-zinc-300">
                          <span className="font-mono text-zinc-500">{ev.actor_name}</span>{" "}
                          <span className="text-zinc-400">{formatEventType(ev.event_type)}</span>
                        </div>
                        <div className="text-[10px] font-mono text-zinc-600">
                          {new Date(ev.timestamp).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">{label}</span>
      <span className="text-zinc-300">{children}</span>
    </div>
  )
}

function formatEventType(type: string): string {
  return type.replace(/_/g, " ")
}
