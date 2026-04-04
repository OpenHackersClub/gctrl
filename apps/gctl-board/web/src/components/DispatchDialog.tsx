import { useState, useEffect } from "react"
import type { Issue, PersonaDefinition } from "../types"
import { api } from "../api/client"

interface Props {
  issue: Issue
  onDispatch: (issue: Issue, personas: PersonaDefinition[]) => Promise<void>
  onSkip: () => void
  onClose: () => void
}

export function DispatchDialog({ issue, onDispatch, onSkip, onClose }: Props) {
  const [personas, setPersonas] = useState<PersonaDefinition[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rationale, setRationale] = useState("")
  const [loading, setLoading] = useState(true)
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function recommend() {
      try {
        const result = await api.team.recommend(issue.labels)
        if (cancelled) return
        setPersonas(result.personas)
        setRationale(result.rationale)
        setSelected(new Set(result.personas.map((p) => p.id)))
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : "Failed to get recommendations")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    recommend()
    return () => { cancelled = true }
  }, [issue.id]) // stable scalar — avoids re-fetch on array reference change

  const togglePersona = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDispatch = async () => {
    if (selected.size === 0 || dispatching) return
    setDispatching(true)
    try {
      const selectedPersonas = personas.filter((p) => selected.has(p.id))
      await onDispatch(issue, selectedPersonas)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dispatch failed")
      setDispatching(false)
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
        <div
          onClick={(e) => e.stopPropagation()}
          data-testid="dispatch-dialog"
          className="w-full max-w-lg bg-zinc-950 border border-zinc-800 shadow-2xl shadow-black/60 pointer-events-auto animate-fade-in-up"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/80">
            <div className="flex items-center gap-3">
              <span className="text-amber-400 text-sm">&#9656;</span>
              <h3 className="font-display font-semibold text-sm tracking-wider text-zinc-200 uppercase">
                Dispatch Agent
              </h3>
              <span className="font-mono text-xs text-emerald-400/70">{issue.id}</span>
            </div>
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

          {/* Issue context */}
          <div className="px-5 py-3 border-b border-zinc-800/50 bg-zinc-900/30">
            <div className="text-sm text-zinc-300 font-medium">{issue.title}</div>
            {issue.labels.length > 0 && (
              <div className="flex gap-1.5 mt-2">
                {issue.labels.map((l) => (
                  <span key={l} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                    {l}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {loading ? (
              <div className="flex items-center gap-3 py-6">
                <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
                <span className="text-sm text-zinc-400 font-mono">Recommending personas...</span>
              </div>
            ) : error ? (
              <div className="py-4 text-sm text-rose-400 font-mono">{error}</div>
            ) : (
              <>
                {/* Rationale */}
                <div className="text-xs text-zinc-500 italic">{rationale}</div>

                {/* Persona list */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                    Select Personas
                  </label>
                  {personas.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePersona(p.id)}
                      className={`w-full text-left px-3 py-2.5 border transition-all cursor-pointer ${
                        selected.has(p.id)
                          ? "bg-emerald-500/10 border-emerald-500/30 text-zinc-200"
                          : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-3 h-3 border flex items-center justify-center text-[8px] ${
                          selected.has(p.id)
                            ? "border-emerald-500 text-emerald-400"
                            : "border-zinc-600"
                        }`}>
                          {selected.has(p.id) ? "\u2713" : ""}
                        </span>
                        <span className="font-mono text-xs text-zinc-500">{p.id}</span>
                        <span className="font-display text-sm font-medium">{p.name}</span>
                      </div>
                      <div className="ml-5 mt-1 text-xs text-zinc-500 leading-relaxed">{p.focus}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={onSkip}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Skip (move without agent)
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDispatch}
                disabled={selected.size === 0 || dispatching || loading}
                className="px-4 py-1.5 text-xs font-display font-medium tracking-wider
                  bg-amber-500/15 text-amber-400 border border-amber-500/30
                  hover:bg-amber-500/25 disabled:opacity-30 disabled:cursor-not-allowed
                  transition-colors cursor-pointer"
              >
                {dispatching ? "DISPATCHING..." : `DISPATCH ${selected.size} AGENT${selected.size !== 1 ? "S" : ""}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
