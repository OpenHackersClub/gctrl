import { useEffect, useState } from "react"
import { api } from "../api/client"
import { cardHeadline, formatUsage, handoffGroups, mapBrief, relativeTime } from "../lib/agent-lanes"
import type { AgentRun, MapHandoff, SessionMap } from "../types"

interface Props {
  run: AgentRun
  /** Changes on every list poll, so the pane re-reads the map. */
  refreshKey: string
  now: Date
  busy: boolean
  onClose: () => void
  onOpen: (run: AgentRun) => void
  onToast: (message: string, type?: "error" | "success") => void
}

const TYPE_CHIP: Record<MapHandoff["type"], { label: string; className: string }> = {
  signoff: { label: "SignOff", className: "bg-violet-500/10 text-violet-300 border-violet-500/25" },
  ops: { label: "Ops", className: "bg-amber-500/10 text-amber-300 border-amber-500/25" },
  task: { label: "Task", className: "bg-sky-500/10 text-sky-300 border-sky-500/25" },
}

const STATUS_CHIP: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
  blocked: "bg-rose-500/10 text-rose-300 border-rose-500/25",
  handoff: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  done: "bg-zinc-700/40 text-zinc-300 border-zinc-600",
}

const SOURCE_LABEL: Record<string, string> = {
  "session-map": "session-map mod",
  transcript: "transcript",
  kernel: "reported to gctrl",
  "codex-goal": "Codex /goal",
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">{title}</h3>
      {children}
    </section>
  )
}

/**
 * The selected run's session map: goal, status, hand-offs, steps, GitHub refs
 * and reports, with Open in iTerm2. Spec:
 * vault/specs/architecture/apps/agent-panel.md § Board page.
 */
export function AgentDetailPane({ run, refreshKey, now, busy, onClose, onOpen, onToast }: Props) {
  const [map, setMap] = useState<SessionMap | null>(run.map ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.agents
      .get(run.id)
      .then((r) => {
        if (cancelled) return
        setMap(r.map ?? null)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [run.id, refreshKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const blocked = run.live === null && !run.cwd_exists
  const action = run.live ? "Go to iTerm2" : "Resume in iTerm2"
  const goal = map?.goal ?? run.goal ?? null
  const status = map?.goal_paused_for ? "blocked" : (map?.status ?? null)
  const steps = map?.steps ?? []
  const done = steps.filter((s) => s.status === "completed").length
  const active = steps.filter((s) => s.status === "in_progress").length
  const usage = formatUsage(run)

  const copy = async () => {
    if (!map) return
    try {
      await navigator.clipboard.writeText(mapBrief(run, map))
      onToast("Session map copied", "success")
    } catch {
      onToast("Clipboard unavailable", "error")
    }
  }

  return (
    <aside
      data-testid="agent-detail-pane"
      aria-label={`Session map: ${cardHeadline(run)}`}
      className="fixed right-0 top-0 bottom-0 z-40 w-[30rem] max-w-[92vw] bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col"
    >
      <header className="px-4 py-3 border-b border-zinc-800 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-mono text-[13px] text-zinc-100 truncate">
              {cardHeadline(run)}
              {run.worktree && <span className="text-zinc-500"> [/{run.worktree}]</span>}
            </h2>
            <p className="text-[11px] font-mono text-zinc-500 truncate">
              {run.harness} · {run.project_key}
              {map?.branch || run.git_branch ? ` · ${map?.branch ?? run.git_branch}` : ""} · {run.state} ·{" "}
              {relativeTime(run.updated_at, now)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200 cursor-pointer text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="pane-open-iterm"
            disabled={blocked || busy}
            onClick={() => onOpen(run)}
            className="px-3 py-1.5 text-[12px] font-mono bg-emerald-600/80 text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            title={run.resume_command ?? (blocked ? "worktree removed" : undefined)}
          >
            {busy ? "Opening…" : `${action} →`}
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!map}
            className="px-3 py-1.5 text-[12px] font-mono border border-zinc-800 text-zinc-300 hover:border-zinc-700 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            Copy map
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-4 py-3 space-y-5 text-[12.5px]">
        <Section title="Goal">
          {goal ? (
            <p className="text-zinc-100 leading-snug">
              {map?.goal_pinned && (
                <span className="mr-1" title="Set with /goal">
                  📌
                </span>
              )}
              {goal}
            </p>
          ) : (
            <p className="text-zinc-600">Not reported.</p>
          )}
          {map?.goal_paused_for && (
            <p className="text-rose-300 text-[12px]">⏸ paused · {map.goal_paused_for}</p>
          )}
        </Section>

        {(status || map?.summary) && (
          <Section title="Status">
            <div className="flex items-start gap-2">
              {status && (
                <span
                  className={`text-[9px] font-mono uppercase tracking-wider px-1 py-px border shrink-0 mt-0.5 ${STATUS_CHIP[status] ?? STATUS_CHIP.active}`}
                >
                  {status}
                </span>
              )}
              {map?.summary && <p className="text-zinc-300 leading-snug">{map.summary}</p>}
            </div>
          </Section>
        )}

        {map && map.handoffs.length > 0 && (
          <Section title="Hand-offs">
            <div className="space-y-2">
              {handoffGroups(map.handoffs).map((g) => (
                <div key={g.who} className="space-y-1">
                  <p className="text-[11px] font-mono text-zinc-400">
                    {g.who.toLowerCase() === "operator" ? "🙋🏻‍♂️" : "🤖"} {g.who}
                  </p>
                  {g.rows.map((h, i) => (
                    <div key={`${g.who}-${i}`} className="flex gap-2 pl-4">
                      <span className="font-mono text-zinc-500 w-6 shrink-0">{h.n == null ? "→" : `\\${h.n}`}</span>
                      <span
                        className={`text-[9px] font-mono px-1 py-px border h-fit shrink-0 ${TYPE_CHIP[h.type].className}`}
                      >
                        {TYPE_CHIP[h.type].label}
                      </span>
                      <div className="min-w-0">
                        <p className="text-zinc-200 leading-snug">{h.action}</p>
                        {h.why && <p className="text-zinc-500 text-[11.5px] leading-snug">{h.why}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Section>
        )}

        {steps.length > 0 && (
          <Section title={`Progress · ${done}/${steps.length}`}>
            <div className="flex h-1.5 w-full bg-zinc-800 overflow-hidden" aria-hidden>
              <div className="bg-emerald-500" style={{ width: `${(done / steps.length) * 100}%` }} />
              <div className="bg-amber-400" style={{ width: `${(active / steps.length) * 100}%` }} />
            </div>
            <ul className="space-y-0.5">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2 leading-snug">
                  <span
                    className={`font-mono shrink-0 ${
                      s.status === "completed"
                        ? "text-emerald-400"
                        : s.status === "in_progress"
                          ? "text-amber-300"
                          : "text-zinc-600"
                    }`}
                  >
                    {s.status === "completed" ? "✓" : s.status === "in_progress" ? "▸" : "○"}
                  </span>
                  <span className={s.status === "completed" ? "text-zinc-500" : "text-zinc-200"}>{s.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {map && map.refs.length > 0 && (
          <Section title="GitHub">
            <ul className="space-y-1">
              {map.refs.map((r) => (
                <li key={`${r.repo}#${r.number}`} className="flex gap-2 items-baseline">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-violet-300 hover:text-violet-200 shrink-0"
                  >
                    {r.kind === "pr" ? "PR" : "Issue"} {r.repo}#{r.number}
                  </a>
                  {r.state && <span className="text-[10px] font-mono text-zinc-500">{r.state}</span>}
                  <span className="text-zinc-400 truncate">{r.title ?? r.roles.join(", ")}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {map && map.reports.length > 0 && (
          <Section title="Reports">
            <ul className="space-y-1">
              {map.reports.map((r) => (
                <li key={r.slug} className="flex gap-2">
                  {r.url && /^https?:\/\//.test(r.url) ? (
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
                      {r.slug}
                    </a>
                  ) : (
                    <span className="text-zinc-300">{r.slug}</span>
                  )}
                  <span className="text-zinc-500 text-[11px]">
                    {r.done ? "answered" : r.unanswered ? `${r.unanswered} unanswered` : "draft"}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Run">
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-[11.5px] font-mono">
            <dt className="text-zinc-500">cwd</dt>
            <dd className="text-zinc-300 break-all">{run.cwd}</dd>
            {run.last_prompt && (
              <>
                <dt className="text-zinc-500">last prompt</dt>
                <dd className="text-zinc-400 font-sans">{run.last_prompt}</dd>
              </>
            )}
            {run.model && (
              <>
                <dt className="text-zinc-500">model</dt>
                <dd className="text-zinc-300">{run.model}</dd>
              </>
            )}
            {usage && (
              <>
                <dt className="text-zinc-500">usage</dt>
                <dd className="text-zinc-300">{usage}</dd>
              </>
            )}
            <dt className="text-zinc-500">started</dt>
            <dd className="text-zinc-300">{relativeTime(run.started_at, now)}</dd>
            {run.live && (
              <>
                <dt className="text-zinc-500">process</dt>
                <dd className="text-zinc-300">
                  pid {run.live.pid}
                  {run.live.tty ? ` · ${run.live.tty}` : ""}
                </dd>
              </>
            )}
            <dt className="text-zinc-500">map</dt>
            <dd className="text-zinc-400">
              {map
                ? `${SOURCE_LABEL[map.source] ?? map.source}${map.updated_at ? ` · ${relativeTime(map.updated_at, now)}` : ""}`
                : error
                  ? `unavailable (${error})`
                  : "none reported"}
            </dd>
          </dl>
        </Section>
      </div>
    </aside>
  )
}
