import { useState, useCallback, useRef } from "react"
import { useProjects, useIssues } from "./hooks/useBoard"
import { KanbanBoard } from "./components/KanbanBoard"
import { IssueDetailPanel } from "./components/IssueDetailPanel"
import { CreateIssueDialog } from "./components/CreateIssueDialog"
import { DispatchDialog } from "./components/DispatchDialog"
import { ProjectSelector } from "./components/ProjectSelector"
import { api } from "./api/client"
import type { Issue, PersonaDefinition } from "./types"

interface Toast {
  id: string
  message: string
  type: "error" | "success"
}

export function App() {
  const { projects, loading: projectsLoading, create: createProject } = useProjects()
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const {
    issues,
    loading: issuesLoading,
    moveIssue,
    createIssue,
    refresh,
  } = useIssues(selectedProjectId)
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [dispatchIssue, setDispatchIssue] = useState<Issue | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const pendingMoveRef = useRef<{ issueId: string; newStatus: string } | null>(null)
  const issuesRef = useRef(issues)
  issuesRef.current = issues

  const addToast = useCallback((message: string, type: "error" | "success" = "error") => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }, [])

  const handleCreateProject = useCallback(
    async (name: string, key: string) => {
      try {
        return await createProject(name, key)
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Failed to create project")
        throw e
      }
    },
    [createProject, addToast]
  )

  const handleMoveIssue = useCallback(
    async (issueId: string, newStatus: string) => {
      // Intercept drag to in_progress — show dispatch dialog
      if (newStatus === "in_progress") {
        const issue = issuesRef.current.find((i) => i.id === issueId)
        if (issue && issue.status !== "in_progress") {
          pendingMoveRef.current = { issueId, newStatus }
          setDispatchIssue(issue)
          return issue // actual move deferred until dispatch decision
        }
      }
      try {
        return await moveIssue(issueId, newStatus)
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Failed to move issue")
        throw e
      }
    },
    [moveIssue, addToast]
  )

  const handleDispatch = useCallback(
    async (issue: Issue, personas: PersonaDefinition[]) => {
      const pending = pendingMoveRef.current
      if (!pending) return
      try {
        // 1. Move the issue to in_progress
        await moveIssue(pending.issueId, pending.newStatus)
        // 2. Render agent prompts with issue context
        const personaIds = personas.map((p) => p.id)
        await api.team.render(personaIds, issue.id)
        // 3. Assign to first persona as the lead agent
        const lead = personas[0]
        await api.issues.assign(issue.id, {
          assignee_id: lead.id,
          assignee_name: lead.name,
          assignee_type: "agent",
        })
        addToast(`Dispatched ${personas.length} agent(s) on ${issue.id}`, "success")
        refresh()
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Dispatch failed")
      } finally {
        pendingMoveRef.current = null
        setDispatchIssue(null)
      }
    },
    [moveIssue, addToast, refresh]
  )

  const handleDispatchSkip = useCallback(async () => {
    const pending = pendingMoveRef.current
    if (!pending) return
    try {
      await moveIssue(pending.issueId, pending.newStatus)
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to move issue")
    } finally {
      pendingMoveRef.current = null
      setDispatchIssue(null)
    }
  }, [moveIssue, addToast])

  const handleCreateIssue = useCallback(
    async (input: {
      title: string
      description?: string
      priority?: string
      labels?: string[]
    }) => {
      try {
        const issue = await createIssue(input)
        addToast(`Created ${issue.id}`, "success")
        setShowCreateDialog(false)
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Failed to create issue")
      }
    },
    [createIssue, addToast]
  )

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 font-body grid-bg">
      {/* ── Header ── */}
      <header className="h-14 border-b border-zinc-800/80 flex items-center justify-between px-5 bg-zinc-950/90 backdrop-blur-sm sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <h1 className="font-display font-semibold text-[15px] tracking-wider text-zinc-100 uppercase select-none">
            gctl<span className="text-emerald-400">.</span>board
          </h1>
          <div className="w-px h-5 bg-zinc-800" />
          <ProjectSelector
            projects={projects}
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
            onCreate={handleCreateProject}
            loading={projectsLoading}
          />
        </div>
        <div className="flex items-center gap-4">
          {selectedProject && (
            <span className="text-xs font-mono text-zinc-500 tracking-wide">
              {selectedProject.key} / {issues.length} issues
            </span>
          )}
          <button
            onClick={() => setShowCreateDialog(true)}
            disabled={!selectedProjectId}
            className="px-3 py-1.5 text-[13px] font-display font-medium tracking-wide
              bg-emerald-500/10 text-emerald-400 border border-emerald-500/25
              hover:bg-emerald-500/20 hover:border-emerald-500/40
              disabled:opacity-25 disabled:cursor-not-allowed
              transition-all duration-150 cursor-pointer"
          >
            + NEW ISSUE
          </button>
        </div>
      </header>

      {/* ── Board ── */}
      <KanbanBoard
        issues={issues}
        loading={issuesLoading}
        hasProject={!!selectedProjectId}
        onMoveIssue={handleMoveIssue}
        onSelectIssue={setSelectedIssue}
      />

      {/* ── Detail Panel ── */}
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
          onUpdate={refresh}
        />
      )}

      {/* ── Create Dialog ── */}
      {showCreateDialog && (
        <CreateIssueDialog
          onSubmit={handleCreateIssue}
          onClose={() => setShowCreateDialog(false)}
        />
      )}

      {/* ── Dispatch Dialog ── */}
      {dispatchIssue && (
        <DispatchDialog
          issue={dispatchIssue}
          onDispatch={handleDispatch}
          onSkip={handleDispatchSkip}
          onClose={() => {
            pendingMoveRef.current = null
            setDispatchIssue(null)
          }}
        />
      )}

      {/* ── Toasts ── */}
      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-2.5 text-[13px] font-mono border animate-fade-in-up pointer-events-auto ${
              toast.type === "error"
                ? "bg-rose-950/80 border-rose-500/30 text-rose-300"
                : "bg-emerald-950/80 border-emerald-500/30 text-emerald-300"
            }`}
          >
            <span className="opacity-50 mr-2">{toast.type === "error" ? "ERR" : "OK "}</span>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}
