import { useEffect, useMemo, useState } from "react"
import { api, type MacosSpace } from "../api/client"
import { gatherPreview } from "../lib/agent-lanes"
import type { AgentRun } from "../types"

interface Props {
  runs: AgentRun[]
  busy: boolean
  onClose: () => void
  /** `spaceId` is null to stay on the current Space. */
  onConfirm: (opts: { spaceId: number | null; closeOld: boolean }) => void
}

function spaceLabel(s: MacosSpace): string {
  const base = s.name ? `${s.name} (${s.system_label})` : s.system_label
  return s.is_current ? `${base} — this Space` : base
}

/**
 * Pick a Space and confirm a gather. Spec:
 * vault/specs/architecture/apps/agent-panel.md § Gather into a Space.
 */
export function GatherDialog({ runs, busy, onClose, onConfirm }: Props) {
  const [spaces, setSpaces] = useState<MacosSpace[] | null>(null)
  const [spaceId, setSpaceId] = useState<number | null>(null)
  const [closeOld, setCloseOld] = useState(true)
  const preview = useMemo(() => gatherPreview(runs), [runs])

  useEffect(() => {
    let cancelled = false
    api.macos
      .spaces()
      .then((list) => {
        if (cancelled) return
        const desktops = list.filter((s) => s.kind === "user")
        setSpaces(desktops)
        setSpaceId(desktops.find((s) => s.is_current)?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setSpaces([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const current = spaces?.find((s) => s.is_current)?.id ?? null
  const lines = [
    preview.resume > 0 && `${preview.resume} resume directly`,
    preview.move > 0 && `${preview.move} idle: stopped, then resumed in the new window`,
    preview.wait > 0 && `${preview.wait} mid-turn: move when the turn ends`,
    preview.skip > 0 && `${preview.skip} skipped (worktree removed or no terminal)`,
  ].filter(Boolean) as string[]

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-label="Gather into a Space"
          data-testid="gather-dialog"
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto w-full max-w-md bg-zinc-950 border border-zinc-800 shadow-2xl"
        >
          <div className="px-4 py-3 border-b border-zinc-800">
            <h2 className="text-sm font-display font-semibold tracking-wide text-zinc-200">
              Gather {runs.length} {runs.length === 1 ? "run" : "runs"} into one window
            </h2>
            <p className="text-[11px] font-mono text-zinc-500 mt-1">
              Opens one iTerm2 window on the chosen Space and resumes each run as a tab.
            </p>
          </div>

          <div className="px-4 py-3 space-y-3 text-[12px] font-mono text-zinc-300">
            <label className="block space-y-1">
              <span className="text-zinc-500">Space</span>
              <select
                data-testid="gather-space"
                value={spaceId ?? ""}
                disabled={!spaces || spaces.length === 0}
                onChange={(e) => setSpaceId(e.target.value === "" ? null : Number(e.target.value))}
                className="w-full bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-200"
              >
                {(!spaces || spaces.length === 0) && <option value="">This Space</option>}
                {spaces?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {spaceLabel(s)}
                  </option>
                ))}
              </select>
            </label>

            <ul className="space-y-0.5 text-zinc-400">
              {lines.map((l) => (
                <li key={l}>· {l}</li>
              ))}
            </ul>

            <label className="flex items-center gap-2 cursor-pointer select-none text-zinc-400">
              <input
                type="checkbox"
                checked={closeOld}
                onChange={(e) => setCloseOld(e.target.checked)}
                data-testid="gather-close-old"
                className="accent-emerald-500"
              />
              Close the panes they leave behind (only when nothing but a shell is left)
            </label>
          </div>

          <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] font-mono text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="gather-confirm"
              disabled={busy || preview.resume + preview.move + preview.wait === 0}
              onClick={() => onConfirm({ spaceId: spaceId === current ? null : spaceId, closeOld })}
              className="px-3 py-1.5 text-[12px] font-mono bg-emerald-600/80 text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              {busy ? "Gathering…" : "Gather"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
