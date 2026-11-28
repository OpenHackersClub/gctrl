import { useEffect, useMemo, useRef, useState } from "react"
import { hideAllButLive, type ProjectOption } from "../lib/agent-lanes"

interface Props {
  options: ProjectOption[]
  hidden: ReadonlySet<string>
  onChange: (hidden: Set<string>) => void
}

/**
 * Multi-select of the projects shown as swimlanes. Spec:
 * vault/specs/architecture/apps/agent-panel.md § Board page.
 */
export function ProjectFilter({ options, hidden, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const shown = options.filter((o) => !hidden.has(o.key)).length
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.key.toLowerCase().includes(q)) : options
  }, [options, query])

  const toggle = (key: string) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  /** Show only `key`: hide every other project. */
  const only = (key: string) => onChange(new Set(options.filter((o) => o.key !== key).map((o) => o.key)))

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="project-filter"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`px-2 py-1 border cursor-pointer ${
          hidden.size > 0
            ? "border-emerald-500/40 text-emerald-300"
            : "border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
        }`}
      >
        Projects {shown}/{options.length} ▾
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Projects to show"
          className="absolute right-0 top-full mt-1 z-30 w-72 bg-zinc-950 border border-zinc-800 shadow-2xl"
        >
          <div className="p-2 border-b border-zinc-800 space-y-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter projects"
              data-testid="project-filter-search"
              className="w-full bg-zinc-900 border border-zinc-800 px-2 py-1 text-zinc-200 placeholder:text-zinc-600"
            />
            <div className="flex gap-3 text-zinc-500">
              <button type="button" className="hover:text-zinc-200 cursor-pointer" onClick={() => onChange(new Set())}>
                All
              </button>
              <button
                type="button"
                className="hover:text-zinc-200 cursor-pointer"
                onClick={() => onChange(new Set(options.map((o) => o.key)))}
              >
                None
              </button>
              <button
                type="button"
                className="hover:text-zinc-200 cursor-pointer"
                onClick={() => onChange(hideAllButLive(options))}
              >
                Live only
              </button>
            </div>
          </div>
          <ul className="max-h-80 overflow-auto py-1">
            {matches.map((o) => (
              <li key={o.key} className="group flex items-center gap-2 px-2 py-1 hover:bg-zinc-900">
                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!hidden.has(o.key)}
                    onChange={() => toggle(o.key)}
                    data-testid={`project-option-${o.key}`}
                    className="accent-emerald-500"
                  />
                  <span className="truncate text-zinc-200">{o.key}</span>
                  {o.live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="live runs" />}
                  <span className="ml-auto text-zinc-600">{o.runs}</span>
                </label>
                <button
                  type="button"
                  onClick={() => only(o.key)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                  title={`Show only ${o.key}`}
                >
                  only
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="px-2 py-2 text-zinc-600">No projects match.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
