import { useCallback, useEffect, useState } from "react"
import {
  api,
  type MacosHealth,
  type MacosPermissionStatus,
  type MacosSpace,
} from "../api/client"

/// Settings → macOS Spaces panel. Surfaces the AX permission state
/// (driver-macos's only blocker for the overlay renderer), provides
/// the "Grant Accessibility" CTA, and lists the user-named Spaces.
///
/// Health is polled every 5s while the panel is mounted so the
/// permission grant flow updates without a manual refresh — granting
/// permission in System Settings is asynchronous from the renderer's
/// perspective.
export function MacosSpacesPage() {
  const [health, setHealth] = useState<MacosHealth | null>(null)
  const [spaces, setSpaces] = useState<MacosSpace[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prompting, setPrompting] = useState(false)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const refresh = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api.macos.health(), api.macos.spaces()])
      setHealth(h)
      setSpaces(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to reach kernel")
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const handleGrant = useCallback(async () => {
    setPrompting(true)
    try {
      await api.macos.promptAccessibility()
      // Permission may take a few seconds to flip in TCC; polling
      // catches it.
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "prompt failed")
    } finally {
      setPrompting(false)
    }
  }, [refresh])

  const handleRename = useCallback(
    async (spaceId: number) => {
      const trimmed = renameValue.trim()
      if (!trimmed) {
        setRenaming(null)
        return
      }
      try {
        await api.macos.name(spaceId, trimmed)
        setRenaming(null)
        setRenameValue("")
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "rename failed")
      }
    },
    [renameValue, refresh],
  )

  const handleClear = useCallback(
    async (spaceId: number) => {
      try {
        await api.macos.unname(spaceId)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "clear failed")
      }
    },
    [refresh],
  )

  // ── render branches ──────────────────────────────────────────
  if (!health) {
    return (
      <div className="p-6 text-zinc-500 font-mono text-sm">
        {error ? (
          <div className="text-rose-400" data-testid="macos-error">
            {error}
          </div>
        ) : (
          <span>loading driver-macos…</span>
        )}
      </div>
    )
  }

  if (health.os !== "macos") {
    return (
      <div className="p-6 max-w-2xl">
        <h2 className="font-display text-zinc-200 text-base mb-2">macOS Spaces</h2>
        <p className="text-zinc-500 font-mono text-sm">
          Named Mission Control Spaces are macOS-only. The kernel is
          running on{" "}
          <span className="text-zinc-300">{health.os}</span>; this panel
          stays empty.
        </p>
      </div>
    )
  }

  const ax = health.permissions.accessibility ?? "not_requested"
  const spacesCapable = health.capabilities.includes("spaces")

  return (
    <div className="p-6 max-w-3xl space-y-6 font-mono">
      <div>
        <h2 className="font-display text-zinc-200 text-base mb-1">macOS Spaces</h2>
        <p className="text-zinc-500 text-xs">
          Named Mission Control Spaces — labels appear over thumbnails when
          you enter Mission Control.
        </p>
      </div>

      {error && (
        <div
          className="px-4 py-2 text-xs bg-rose-950/60 border border-rose-500/30 text-rose-300"
          data-testid="macos-error"
        >
          {error}
        </div>
      )}

      <PermissionCard
        status={ax}
        prompting={prompting}
        onGrant={handleGrant}
      />

      <CapabilityRow capable={spacesCapable} versionSkew={health.version_skew} />

      <SpacesList
        spaces={spaces}
        renaming={renaming}
        renameValue={renameValue}
        onStartRename={(id, current) => {
          setRenaming(id)
          setRenameValue(current ?? "")
        }}
        onChangeRename={setRenameValue}
        onCommitRename={handleRename}
        onCancelRename={() => {
          setRenaming(null)
          setRenameValue("")
        }}
        onClear={handleClear}
      />
    </div>
  )
}

// ── sub-components ───────────────────────────────────────────────

function PermissionCard({
  status,
  prompting,
  onGrant,
}: {
  status: MacosPermissionStatus
  prompting: boolean
  onGrant: () => void
}) {
  if (status === "granted") {
    return (
      <div
        className="px-4 py-3 bg-emerald-950/40 border border-emerald-500/30 flex items-center gap-3"
        data-testid="ax-granted"
      >
        <span className="text-emerald-400 text-xs font-bold">✓ GRANTED</span>
        <span className="text-zinc-400 text-xs">
          Accessibility permission active — overlay renderer can draw labels.
        </span>
      </div>
    )
  }
  const blurb =
    "Named Mission Control Spaces requires Accessibility permission. " +
    "Without it gctrl cannot draw labels on top of Mission Control."
  return (
    <div
      className="p-4 bg-zinc-900/60 border border-zinc-700"
      data-testid="ax-cta"
    >
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-amber-400 text-xs font-bold uppercase tracking-wider">
          permission required
        </span>
        <span className="text-zinc-500 text-xs">accessibility · {status}</span>
      </div>
      <p className="text-zinc-400 text-xs mb-3 leading-relaxed">{blurb}</p>
      <button
        onClick={onGrant}
        disabled={prompting || status === "not_promptable"}
        data-testid="grant-accessibility"
        className="px-4 py-2 text-xs font-display tracking-wide bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
      >
        {prompting ? "PROMPTING…" : "GRANT ACCESSIBILITY"}
      </button>
      {status === "not_promptable" && (
        <p className="mt-3 text-zinc-500 text-[11px]">
          The system can't surface the prompt automatically — open
          System Settings → Privacy & Security → Accessibility and add
          gctrl manually.
        </p>
      )}
    </div>
  )
}

function CapabilityRow({
  capable,
  versionSkew,
}: {
  capable: boolean
  versionSkew: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-zinc-500">
      <span
        data-testid="capability-spaces"
        className={capable ? "text-emerald-400" : "text-zinc-600"}
      >
        spaces.{capable ? "on" : "off"}
      </span>
      {versionSkew && (
        <span className="text-amber-400" data-testid="version-skew">
          version_skew · layout fixture mismatch — overlay disabled
        </span>
      )}
    </div>
  )
}

function SpacesList({
  spaces,
  renaming,
  renameValue,
  onStartRename,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onClear,
}: {
  spaces: MacosSpace[] | null
  renaming: number | null
  renameValue: string
  onStartRename: (id: number, current: string | null) => void
  onChangeRename: (v: string) => void
  onCommitRename: (id: number) => void
  onCancelRename: () => void
  onClear: (id: number) => void
}) {
  if (!spaces) return null
  if (spaces.length === 0) {
    return (
      <div className="text-zinc-500 text-xs">
        No labels yet. Spaces appear here once you name them.
      </div>
    )
  }
  return (
    <ul className="divide-y divide-zinc-800 border border-zinc-800">
      {spaces.map((s) => (
        <li
          key={s.id}
          data-testid={`space-row-${s.index}`}
          className="px-4 py-3 flex items-center gap-4 hover:bg-zinc-900/40"
        >
          <span className="text-zinc-500 text-xs w-24 shrink-0">
            {s.system_label}
          </span>
          {renaming === s.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => onChangeRename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCommitRename(s.id)
                else if (e.key === "Escape") onCancelRename()
              }}
              onBlur={() => onCommitRename(s.id)}
              className="flex-1 bg-zinc-950 border border-emerald-500/40 px-2 py-1 text-sm text-zinc-200 outline-none"
            />
          ) : (
            <span
              className={`flex-1 text-sm cursor-pointer ${s.name ? "text-zinc-200" : "text-zinc-600 italic"}`}
              onClick={() => onStartRename(s.id, s.name)}
            >
              {s.name ?? "click to name"}
            </span>
          )}
          {s.is_current && (
            <span className="text-emerald-400 text-[10px] font-bold tracking-wider">
              CURRENT
            </span>
          )}
          {s.name && renaming !== s.id && (
            <button
              onClick={() => onClear(s.id)}
              className="text-zinc-600 hover:text-rose-400 text-[10px] tracking-wider cursor-pointer"
            >
              CLEAR
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
