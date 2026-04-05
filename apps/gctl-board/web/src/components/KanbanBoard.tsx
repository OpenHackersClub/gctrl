import { useState } from "react"
import {
  DndContext,
  DragOverlay,
  useDroppable,
  useDraggable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import type { Issue, IssueStatus } from "../types"
import { STATUS_LABELS } from "../types"
import { IssueCard } from "./IssueCard"

const VISIBLE_STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
]

const COLUMN_ACCENT: Record<string, string> = {
  backlog: "#52525b",
  todo: "#38bdf8",
  in_progress: "#f59e0b",
  in_review: "#a78bfa",
  done: "#34d399",
}

interface Props {
  issues: Issue[]
  loading: boolean
  hasProject: boolean
  onMoveIssue: (issueId: string, newStatus: string) => Promise<Issue>
  onSelectIssue: (issue: Issue) => void
}

export function KanbanBoard({ issues, loading, hasProject, onMoveIssue, onSelectIssue }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  if (!hasProject) {
    return <EmptyState />
  }

  const issuesByStatus: Record<string, Issue[]> = {}
  for (const status of VISIBLE_STATUSES) {
    issuesByStatus[status] = issues.filter((i) => i.status === status)
  }

  const activeIssue = activeId ? issues.find((i) => i.id === activeId) ?? null : null

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)

    if (!over) return
    const issueId = active.id as string
    const newStatus = over.id as string
    const issue = issues.find((i) => i.id === issueId)
    if (!issue || issue.status === newStatus) return

    try {
      await onMoveIssue(issueId, newStatus)
    } catch {
      // error toast handled by parent
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 px-4 py-3 h-[calc(100vh-3.5rem)] overflow-x-auto">
        {VISIBLE_STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={issuesByStatus[status]}
            loading={loading}
            isActive={!!activeId}
            onSelectIssue={onSelectIssue}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeIssue ? <IssueCard issue={activeIssue} isOverlay /> : null}
      </DragOverlay>
    </DndContext>
  )
}

/* ── Column ── */

function KanbanColumn({
  status,
  issues,
  loading,
  isActive,
  onSelectIssue,
}: {
  status: IssueStatus
  issues: Issue[]
  loading: boolean
  isActive: boolean
  onSelectIssue: (issue: Issue) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const accent = COLUMN_ACCENT[status]

  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${status}`}
      className={`flex-1 min-w-[220px] max-w-[320px] flex flex-col transition-all duration-150 ${
        isOver ? "column-drop-active" : ""
      } ${isActive && !isOver ? "opacity-80" : ""}`}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 py-2 mb-2" style={{ borderTop: `2px solid ${accent}` }}>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span className="text-xs font-display font-semibold tracking-wider text-zinc-400 uppercase">
          {STATUS_LABELS[status]}
        </span>
        <span className="text-[10px] font-mono text-zinc-600 ml-auto">
          {issues.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto space-y-2 px-0.5 pb-4">
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : issues.length === 0 ? (
          <div className="py-8 text-center">
            <span className="text-[11px] font-mono text-zinc-700">empty</span>
          </div>
        ) : (
          issues.map((issue) => (
            <DraggableIssueCard
              key={issue.id}
              issue={issue}
              onSelect={() => onSelectIssue(issue)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ── Draggable wrapper ── */

function DraggableIssueCard({
  issue,
  onSelect,
}: {
  issue: Issue
  onSelect: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issue.id,
    data: { issue },
  })

  return (
    <div ref={setNodeRef} data-testid={`issue-card-${issue.id}`} {...attributes} {...listeners}>
      <IssueCard issue={issue} onClick={onSelect} isDragging={isDragging} />
    </div>
  )
}

/* ── Empty / Loading states ── */

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-3.5rem)]">
      <div className="text-center space-y-3">
        <div className="font-mono text-zinc-700 text-sm">
          {">"} no project selected
        </div>
        <div className="text-xs text-zinc-600">
          Select or create a project to start tracking issues
        </div>
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
      <div className="skeleton h-3 w-16 rounded-sm" />
      <div className="skeleton h-4 w-full rounded-sm" />
      <div className="skeleton h-3 w-24 rounded-sm" />
    </div>
  )
}
