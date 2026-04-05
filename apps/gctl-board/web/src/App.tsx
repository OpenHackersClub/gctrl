import { useState, useCallback, useRef } from "react"
import { useProjects, useIssues } from "./hooks/useBoard"
import { useProjectRoute } from "./hooks/useProjectRoute"
import { KanbanBoard } from "./components/KanbanBoard"
import { IssueDetailPanel } from "./components/IssueDetailPanel"
import { CreateIssueDialog } from "./components/CreateIssueDialog"
import { ProjectSelector } from "./components/ProjectSelector"
import { api } from "./api/client"
import type { Issue } from "./types"

interface Toast {
  id: string
  message: string
  type: "error" | "success"
}

export function App() {
  const { projects, loading: projectsLoading, create: createProject } = useProjects()
  const { selectedProjectId, selectProject: setSelectedProjectId } = useProjectRoute(projects)
  const {
    issues,
    loading: issuesLoading,
    moveIssue,
    createIssue,
    refresh,
  } = useIssues(selectedProjectId)
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
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
      try {
        const result = await moveIssue(issueId, newStatus)

        // Auto-dispatch: when moved to in_progress, recommend + assign + post prompt
        if (newStatus === "in_progress") {
          const issue = issuesRef.current.find((i) => i.id === issueId)
          if (issue) {
            autoDispatch(issue).catch(() => {
              // non-blocking — issue already moved, dispatch is best-effort
            })
          }
        }

        return result
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Failed to move issue")
        throw e
      }
    },
    [moveIssue, addToast]
  )

  /** Auto-dispatch: gather context → recommend → render → assign → post prompt.
   *  Each step is independently resilient — if persona recommendation fails,
   *  still posts the prior-work context comment for agent pickup. */
  const autoDispatch = useCallback(
    async (issue: Issue) => {
      try {
        // 1. Gather prior work context (best-effort)
        const [comments, events] = await Promise.all([
          api.issues.comments(issue.id).catch(() => []),
          api.issues.events(issue.id).catch(() => []),
        ])

        // 2. Try persona recommendation + rendering (optional — may not be seeded)
        let agentPrompts: string | null = null
        let assignedPersona: string | null = null
        try {
          const rec = await api.team.recommend(issue.labels)
          if (rec.personas.length > 0) {
            const personaIds = rec.personas.map((p) => p.id)
            const rendered = await api.team.render(personaIds, issue.id)

            const lead = rec.personas[0]
            await api.issues.assign(issue.id, {
              assignee_id: lead.id,
              assignee_name: lead.name,
              assignee_type: "agent",
            })
            assignedPersona = lead.name

            if (rendered.agents.length > 0) {
              agentPrompts = rendered.agents
                .map((a) => `## Agent: ${a.name}\n\n${a.prompt}`)
                .join("\n\n---\n\n")
            }
          }
        } catch {
          // Persona recommendation unavailable — dispatch continues without it
        }

        // 3. Build dispatch comment with prior work context
        const sections: string[] = []

        sections.push(
          "## IMPORTANT: Check current implementation first\n\n" +
          "Before starting work, you MUST:\n" +
          "1. Run `git log --oneline -20` to see recent commits\n" +
          "2. Run `git diff main..HEAD --stat` to see what's already changed\n" +
          "3. Read any linked PRs or sessions listed below\n" +
          "4. Check the issue comments below for prior work notes\n" +
          "5. Do NOT redo work that is already done — build on it\n"
        )

        if (issue.description) {
          sections.push(`## Description\n\n${issue.description}`)
        }

        if (comments.length > 0) {
          const commentSummary = comments
            .map((c) => `- **${c.author_name}** (${new Date(c.created_at).toLocaleDateString()}): ${c.body.slice(0, 200)}`)
            .join("\n")
          sections.push(`## Prior Comments\n\n${commentSummary}`)
        }

        if (issue.session_ids.length > 0) {
          sections.push(
            `## Linked Sessions\n\n` +
            issue.session_ids.map((s) => `- \`${s}\``).join("\n") +
            `\n\nTotal cost: $${issue.total_cost_usd.toFixed(2)} / ${issue.total_tokens.toLocaleString()} tokens`
          )
        }

        if (issue.pr_numbers.length > 0) {
          sections.push(
            `## Linked PRs\n\n` +
            issue.pr_numbers.map((n) => `- PR #${n}`).join("\n")
          )
        }

        const statusChanges = events.filter((e) => e.event_type === "status_changed")
        if (statusChanges.length > 0) {
          sections.push(
            `## Status History\n\n` +
            statusChanges.map((e) => `- ${e.actor_name} changed status (${new Date(e.timestamp).toLocaleDateString()})`).join("\n")
          )
        }

        if (agentPrompts) {
          sections.push(agentPrompts)
        }

        // 4. Post dispatch comment — this is the agent's pickup signal
        await api.issues.addComment(issue.id, {
          author_id: "gctl-dispatch",
          author_name: "gctl-dispatch",
          author_type: "agent",
          body: sections.join("\n\n---\n\n"),
        })

        const msg = assignedPersona
          ? `Dispatched ${assignedPersona} on ${issue.id}`
          : `Dispatch context posted on ${issue.id}`
        addToast(msg, "success")
        refresh()
      } catch (e) {
        // Even the comment post failed — still not critical, issue is already in_progress
        addToast(`Dispatch note failed for ${issue.id} — issue still moved`, "error")
      }
    },
    [addToast, refresh]
  )

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

      {/* Dispatch is now automatic — no dialog needed */}

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
