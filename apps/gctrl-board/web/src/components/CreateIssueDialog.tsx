import { useState } from "react"
import type { Priority } from "../types"
import { PRIORITY_ORDER } from "../types"

interface Props {
  onSubmit: (input: {
    title: string
    description?: string
    priority?: string
    labels?: string[]
  }) => Promise<void>
  onClose: () => void
}

export function CreateIssueDialog({ onSubmit, onClose }: Props) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<Priority>("none")
  const [labelsInput, setLabelsInput] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    const labels = labelsInput
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        labels: labels.length > 0 ? labels : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <form
          onSubmit={handleSubmit}
          onClick={(e) => e.stopPropagation()}
          data-testid="create-issue-dialog"
          className="w-full max-w-md bg-zinc-950 border border-zinc-800 shadow-2xl shadow-black/60 pointer-events-auto animate-fade-in-up"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/80">
            <h3 className="font-display font-semibold text-sm tracking-wider text-zinc-200 uppercase">
              New Issue
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="square" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* Title */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                Title *
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 text-zinc-200
                  placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none"
                autoFocus
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Details, context, acceptance criteria..."
                rows={4}
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 text-zinc-200
                  placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none resize-none"
              />
            </div>

            {/* Priority */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                Priority
              </label>
              <div className="flex gap-1">
                {PRIORITY_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-2.5 py-1 text-xs font-mono transition-all cursor-pointer border ${
                      priority === p
                        ? "bg-zinc-800 text-zinc-200 border-zinc-600"
                        : "bg-zinc-900/50 text-zinc-500 border-zinc-800 hover:border-zinc-700"
                    }`}
                  >
                    {p === "none" ? "-" : p.slice(0, 3).toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Labels */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                Labels
              </label>
              <input
                type="text"
                value={labelsInput}
                onChange={(e) => setLabelsInput(e.target.value)}
                placeholder="bug, frontend, auth (comma-separated)"
                className="w-full px-3 py-2 text-sm font-mono bg-zinc-900 border border-zinc-800 text-zinc-200
                  placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="px-4 py-1.5 text-xs font-display font-medium tracking-wider
                bg-emerald-500/15 text-emerald-400 border border-emerald-500/30
                hover:bg-emerald-500/25 disabled:opacity-30 disabled:cursor-not-allowed
                transition-colors cursor-pointer"
            >
              {submitting ? "CREATING..." : "CREATE ISSUE"}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
