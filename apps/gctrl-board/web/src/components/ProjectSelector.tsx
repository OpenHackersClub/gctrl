import { useState, useRef, useEffect } from "react"
import type { Project } from "../types"

interface Props {
  projects: Project[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onCreate: (name: string, key: string) => Promise<Project>
  loading: boolean
}

export function ProjectSelector({ projects, selectedId, onSelect, onCreate, loading }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newKey, setNewKey] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  const selected = projects.find((p) => p.id === selectedId)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const handleCreate = async () => {
    if (!newName.trim() || !newKey.trim()) return
    try {
      const project = await onCreate(newName.trim(), newKey.trim().toUpperCase())
      onSelect(project.id)
      setCreating(false)
      setNewName("")
      setNewKey("")
      setOpen(false)
    } catch {
      // parent handles error
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2.5 py-1 text-sm
          bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700
          transition-colors cursor-pointer min-w-[160px]"
      >
        {loading ? (
          <span className="text-zinc-500 font-mono text-xs">loading...</span>
        ) : selected ? (
          <>
            <span className="font-mono text-xs text-emerald-400/80">{selected.key}</span>
            <span className="text-zinc-300 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-zinc-500">Select project</span>
        )}
        <svg className="w-3 h-3 ml-auto text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="square" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto bg-zinc-900 border border-zinc-800 shadow-xl shadow-black/40 z-40 animate-fade-in">
          {projects.length === 0 && !creating && (
            <div className="px-3 py-4 text-center text-sm text-zinc-500">No projects yet</div>
          )}

          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onSelect(p.id)
                setOpen(false)
              }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-zinc-800/80 transition-colors cursor-pointer ${
                p.id === selectedId ? "bg-zinc-800/50" : ""
              }`}
            >
              <span className="font-mono text-xs text-emerald-400/70 w-12 shrink-0">{p.key}</span>
              <span className="text-sm text-zinc-300 truncate">{p.name}</span>
              {p.github_repo && (
                <span className="ml-auto text-[10px] font-mono text-zinc-600">GH</span>
              )}
            </button>
          ))}

          <div className="border-t border-zinc-800">
            {creating ? (
              <div className="p-3 space-y-2">
                <input
                  type="text"
                  placeholder="Project name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm bg-zinc-950 border border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="KEY (e.g. BACK)"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                  className="w-full px-2 py-1.5 text-sm font-mono bg-zinc-950 border border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none uppercase"
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleCreate}
                    className="flex-1 px-2 py-1.5 text-xs font-display tracking-wide bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors cursor-pointer"
                  >
                    CREATE
                  </button>
                  <button
                    onClick={() => {
                      setCreating(false)
                      setNewName("")
                      setNewKey("")
                    }}
                    className="px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full text-left px-3 py-2.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors cursor-pointer"
              >
                + Create project
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
