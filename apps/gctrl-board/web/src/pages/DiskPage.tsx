import { useCallback, useEffect, useMemo, useState } from "react"
import { api, type DiskReport, type DockerDiskReport } from "../api/client"

const COLORS = ["#34d399", "#38bdf8", "#fbbf24", "#a78bfa", "#fb7185", "#71717a"]

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}

export function DiskPage() {
  const [report, setReport] = useState<DiskReport | null>(null)
  const [docker, setDocker] = useState<DockerDiskReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [filesystem, dockerCache] = await Promise.all([api.disk.usage(), api.disk.docker()])
      setReport(filesystem)
      setDocker(dockerCache)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to scan disk usage")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const slices = useMemo(() => {
    if (!report) return []
    const total = report.roots.reduce((sum, root) => sum + root.bytes, 0)
    const candidateTotal = report.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
    const entries = report.candidates.slice(0, 5).map((candidate) => ({
      label: candidate.path,
      bytes: candidate.bytes,
    }))
    const remaining = Math.max(0, total - entries.reduce((sum, entry) => sum + entry.bytes, 0))
    if (remaining > 0) entries.push({ label: "Other files in allowed paths", bytes: remaining })
    return entries.map((entry, index) => ({ ...entry, color: COLORS[index], total, candidateTotal }))
  }, [report])

  const gradient = useMemo(() => {
    let cursor = 0
    const stops = slices.map((slice) => {
      const start = cursor
      cursor += slice.total > 0 ? (slice.bytes / slice.total) * 100 : 0
      return `${slice.color} ${start}% ${cursor}%`
    })
    return stops.length ? `conic-gradient(${stops.join(", ")})` : "#27272a"
  }, [slices])

  const dockerBytes = docker?.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) ?? 0
  const reclaimableBytes = docker?.candidates.filter((candidate) => candidate.reclaimable).reduce((sum, candidate) => sum + candidate.bytes, 0) ?? 0
  const dockerGradient = dockerBytes > 0
    ? `conic-gradient(#34d399 0% ${(reclaimableBytes / dockerBytes) * 100}%, #71717a ${(reclaimableBytes / dockerBytes) * 100}% 100%)`
    : "#27272a"

  const remove = async (path: string) => {
    setBusy(path)
    try {
      await api.disk.remove(path)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove build output")
    } finally {
      setBusy(null)
    }
  }

  const prune = async (id: string) => {
    setBusy(id)
    try {
      await api.disk.prune(id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prune Docker cache")
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-display font-semibold text-zinc-100">Build disk usage</h2>
          <p className="text-sm text-zinc-500 mt-1">Only configured paths are scanned. Build outputs can be removed individually.</p>
        </div>
        <button onClick={() => void refresh()} disabled={loading} className="px-3 py-1.5 text-sm border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Scan again</button>
      </div>

      {error && <p role="alert" className="text-sm text-red-300 border border-red-900 bg-red-950/40 p-3">{error}</p>}
      {loading && !report && <p className="text-zinc-500">Scanning allowed paths…</p>}
      {report?.roots.length === 0 && (
        <div className="border border-zinc-800 bg-zinc-900/40 p-5 text-sm text-zinc-400">
          Set <code className="text-zinc-200">GCTRL_DISK_ALLOWLIST</code> to a JSON array of absolute directories and restart the kernel. No paths are scanned by default.
        </div>
      )}

      {report && report.roots.length > 0 && (
        <>
          <section className="border border-zinc-800 bg-zinc-900/40 p-5 flex flex-wrap items-center gap-8">
            <div role="img" aria-label="Pie chart of disk usage in allowed paths" className="w-48 h-48 rounded-full shrink-0" style={{ background: gradient }} />
            <div className="space-y-3 min-w-0">
              <p className="text-2xl font-mono text-zinc-100">{size(report.roots.reduce((sum, root) => sum + root.bytes, 0))}</p>
              <p className="text-xs uppercase tracking-wide text-zinc-500">In allowed paths</p>
              <ul className="space-y-1.5 text-sm">
                {slices.map((slice) => <li key={slice.label} className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 shrink-0" style={{ backgroundColor: slice.color }} />
                  <span className="truncate max-w-80" title={slice.label}>{slice.label}</span>
                  <span className="font-mono text-zinc-400 whitespace-nowrap">{size(slice.bytes)}</span>
                </li>)}
              </ul>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="font-display text-sm uppercase tracking-wide text-zinc-300">Removal candidates</h3>
            {report.candidates.length === 0 ? <p className="text-sm text-zinc-500">No recognized build directories in the allowed paths.</p> : (
              <div className="border border-zinc-800 divide-y divide-zinc-800">
                {report.candidates.map((candidate) => <div key={candidate.path} className="p-4 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200">{candidate.kind} <span className="font-mono text-zinc-400">· {size(candidate.bytes)}</span></p>
                    <p className="text-xs font-mono text-zinc-500 truncate" title={candidate.path}>{candidate.path}</p>
                  </div>
                  <button onClick={() => void remove(candidate.path)} disabled={busy !== null} aria-label={`Remove ${candidate.path}`} className="px-3 py-1.5 text-xs border border-red-900 text-red-300 hover:bg-red-950/50 disabled:opacity-50">{busy === candidate.path ? "Removing…" : "Remove"}</button>
                </div>)}
              </div>
            )}
          </section>
        </>
      )}

      {docker && <section className="space-y-3">
        <h3 className="font-display text-sm uppercase tracking-wide text-zinc-300">Docker build cache</h3>
        {!docker.available ? (
          <p className="text-sm text-zinc-500">Unavailable: {docker.reason}</p>
        ) : docker.candidates.length === 0 ? (
          <p className="text-sm text-zinc-500">No cache records in the active local builder.</p>
        ) : <>
          <div className="border border-zinc-800 bg-zinc-900/40 p-5 flex items-center gap-6">
            <div role="img" aria-label="Pie chart of reclaimable and retained Docker build cache records" className="w-28 h-28 rounded-full shrink-0" style={{ background: dockerGradient }} />
            <div className="text-sm space-y-1">
              <p className="text-emerald-300">Reclaimable · {size(reclaimableBytes)}</p>
              <p className="text-zinc-400">Retained · {size(dockerBytes - reclaimableBytes)}</p>
              <p className="text-xs text-zinc-500">Cache records can share storage; these sizes are estimates.</p>
            </div>
          </div>
          <div className="border border-zinc-800 divide-y divide-zinc-800">
          {docker.candidates.map((candidate) => <div key={candidate.id} className="p-4 flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200 truncate" title={candidate.description}>{candidate.description}</p>
              <p className="text-xs font-mono text-zinc-500">{candidate.id} · {size(candidate.bytes)}</p>
            </div>
            <button onClick={() => void prune(candidate.id)} disabled={busy !== null || !candidate.reclaimable} aria-label={`Prune Docker cache ${candidate.id}`} className="px-3 py-1.5 text-xs border border-red-900 text-red-300 hover:bg-red-950/50 disabled:opacity-50">{busy === candidate.id ? "Pruning…" : "Prune"}</button>
          </div>)}
          </div>
        </>}
      </section>}
    </main>
  )
}
