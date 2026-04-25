import { useCallback, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import type { GanttIssue, GanttView, IssueStatus } from "../types"
import { STATUS_LABELS } from "../types"
import {
  ZOOM,
  type ZoomMode,
  addDays,
  barRect,
  columnDateAt,
  dayTicks,
  daysBetween,
  formatDate,
  gridCoordinateGetter,
  rangeDays,
  snapDeltaDays,
} from "../lib/gantt-geom"

const VISIBLE_STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
]

const STATUS_ACCENT: Record<string, string> = {
  backlog: "#52525b",
  todo: "#38bdf8",
  in_progress: "#f59e0b",
  in_review: "#a78bfa",
  done: "#34d399",
  cancelled: "#71717a",
}

const ROW_HEIGHT = 40
const SWIMLANE_HEADER_WIDTH = 160
const AXIS_HEIGHT = 36
const DEFAULT_SPAN_DAYS = 3

type DragKind = "bar-move" | "bar-resize-l" | "bar-resize-r" | "unscheduled"

interface DragData {
  kind: DragKind
  issueId: string
  issue: GanttIssue
}

interface LaneDropData {
  type: "lane"
  status: IssueStatus
}

interface Props {
  data: GanttView | null
  loading: boolean
  hasProject: boolean
  onSelectIssue?: (issueId: string) => void
  onUpdateSchedule?: (
    issueId: string,
    patch: { start_date?: string | null; due_date?: string | null },
  ) => Promise<void>
  onMoveStatus?: (issueId: string, newStatus: IssueStatus) => Promise<void>
  onError?: (message: string) => void
}

export function GanttBoard({
  data,
  loading,
  hasProject,
  onSelectIssue,
  onUpdateSchedule,
  onMoveStatus,
  onError,
}: Props) {
  const [zoom, setZoom] = useState<ZoomMode>("week")

  if (!hasProject) return <EmptyState />

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <GanttToolbar zoom={zoom} onZoomChange={setZoom} />
      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600 font-mono text-sm">
          loading…
        </div>
      ) : data ? (
        <GanttGrid
          data={data}
          zoom={zoom}
          onSelectIssue={onSelectIssue}
          onUpdateSchedule={onUpdateSchedule}
          onMoveStatus={onMoveStatus}
          onError={onError}
        />
      ) : null}
    </div>
  )
}

/* ── Toolbar ──────────────────────────────────────────────── */

function GanttToolbar({
  zoom,
  onZoomChange,
}: {
  zoom: ZoomMode
  onZoomChange: (z: ZoomMode) => void
}) {
  const modes: ZoomMode[] = ["day", "week", "month", "quarter"]
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/60">
      <span className="text-[11px] font-display font-semibold tracking-widest uppercase text-zinc-500">
        Zoom
      </span>
      <div className="flex gap-px bg-zinc-800/60 p-px">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => onZoomChange(m)}
            data-testid={`zoom-${m}`}
            className={`px-2.5 py-1 text-[11px] font-mono tracking-wide cursor-pointer transition-colors ${
              zoom === m
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-zinc-900/60 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <span className="ml-auto text-[11px] font-mono text-zinc-600">
        Group by: status
      </span>
    </div>
  )
}

/* ── Grid ─────────────────────────────────────────────────── */

function GanttGrid({
  data,
  zoom,
  onSelectIssue,
  onUpdateSchedule,
  onMoveStatus,
  onError,
}: {
  data: GanttView
  zoom: ZoomMode
  onSelectIssue?: (issueId: string) => void
  onUpdateSchedule?: Props["onUpdateSchedule"]
  onMoveStatus?: Props["onMoveStatus"]
  onError?: Props["onError"]
}) {
  const { colWidth, snapDays } = ZOOM[zoom]
  const gridRowsRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState<DragData | null>(null)

  // Split scheduled vs unscheduled.
  const { scheduled, unscheduled } = useMemo(() => {
    const s: GanttIssue[] = []
    const u: GanttIssue[] = []
    for (const i of data.issues) {
      if (i.start_date || i.due_date) s.push(i)
      else u.push(i)
    }
    return { scheduled: s, unscheduled: u }
  }, [data.issues])

  // Pad the server-side range to include today and one zoom-window of headroom.
  const paddedRange = useMemo(() => {
    const today = formatDate(Date.now())
    const serverMin = data.range.min ?? today
    const serverMax = data.range.max ?? today
    let min = serverMin < today ? serverMin : today
    let max = serverMax > today ? serverMax : today
    const padDays = zoom === "day" ? 7 : zoom === "week" ? 21 : zoom === "month" ? 60 : 180
    max = addDays(max, padDays)
    min = addDays(min, -Math.floor(padDays / 3))
    return { min, max }
  }, [data.range, zoom])

  const ticks = useMemo(() => dayTicks(paddedRange), [paddedRange])
  const totalWidth = rangeDays(paddedRange) * colWidth

  const lanes = [...VISIBLE_STATUSES, "cancelled" as IssueStatus]
  const byStatus: Record<string, GanttIssue[]> = {}
  for (const lane of lanes) byStatus[lane] = []
  for (const i of scheduled) {
    const lane = lanes.includes(i.status) ? i.status : "backlog"
    byStatus[lane].push(i)
  }

  const todayStr = formatDate(Date.now())
  const todayInRange = todayStr >= paddedRange.min && todayStr <= paddedRange.max
  const todayLeft = todayInRange ? daysBetween(paddedRange.min, todayStr) * colWidth : 0

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: gridCoordinateGetter({
        colWidth,
        rowHeight: ROW_HEIGHT,
      }) as never,
    }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const d = event.active.data.current as DragData | undefined
    if (d) setActive(d)
  }, [])

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const current = active
      setActive(null)
      if (!current || !onUpdateSchedule) return

      const { issue, kind, issueId } = current
      const delta = event.delta
      const laneData = (event.over?.data.current as LaneDropData | undefined) ?? null

      const shiftBoth = (daysDelta: number) => {
        if (!issue.start_date && !issue.due_date) return null
        const nextStart = issue.start_date
          ? addDays(issue.start_date, daysDelta)
          : issue.start_date
        const nextDue = issue.due_date
          ? addDays(issue.due_date, daysDelta)
          : issue.due_date
        return {
          start_date: nextStart ?? null,
          due_date: nextDue ?? null,
        }
      }

      try {
        if (kind === "bar-move") {
          const daysDelta = snapDeltaDays(delta.x, colWidth, snapDays)
          const statusChanged =
            laneData?.type === "lane" && laneData.status !== issue.status

          const datePatch = daysDelta !== 0 ? shiftBoth(daysDelta) : null
          const ops: Promise<void>[] = []
          if (datePatch) ops.push(onUpdateSchedule(issueId, datePatch))
          if (statusChanged && onMoveStatus) {
            ops.push(onMoveStatus(issueId, laneData!.status))
          }
          if (ops.length === 0) return
          // Partial-failure policy: per spec — date call fails → rollback is
          // handled by the hook (throws); if status fails, keep the date change.
          const results = await Promise.allSettled(ops)
          for (const r of results) {
            if (r.status === "rejected") {
              onError?.(r.reason instanceof Error ? r.reason.message : String(r.reason))
            }
          }
        } else if (kind === "bar-resize-l") {
          const daysDelta = snapDeltaDays(delta.x, colWidth, snapDays)
          if (daysDelta === 0 || !issue.start_date) return
          await onUpdateSchedule(issueId, {
            start_date: addDays(issue.start_date, daysDelta),
          })
        } else if (kind === "bar-resize-r") {
          const daysDelta = snapDeltaDays(delta.x, colWidth, snapDays)
          if (daysDelta === 0 || !issue.due_date) return
          await onUpdateSchedule(issueId, {
            due_date: addDays(issue.due_date, daysDelta),
          })
        } else if (kind === "unscheduled") {
          if (!laneData) return
          // Resolve drop column from final pointer X vs grid origin.
          const rowsEl = gridRowsRef.current
          if (!rowsEl) return
          const rect = rowsEl.getBoundingClientRect()
          const gridOrigin = rect.left - (scrollerRef.current?.scrollLeft ?? 0)
          const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined
          const startX =
            typeof activator?.clientX === "number" ? activator.clientX : rect.left
          const finalX = startX + delta.x
          const targetDate = columnDateAt(finalX, gridOrigin, colWidth, paddedRange)

          const patch = {
            start_date: targetDate,
            due_date: addDays(targetDate, DEFAULT_SPAN_DAYS - 1),
          }
          const ops: Promise<void>[] = [onUpdateSchedule(issueId, patch)]
          if (laneData.status !== issue.status && onMoveStatus) {
            ops.push(onMoveStatus(issueId, laneData.status))
          }
          const results = await Promise.allSettled(ops)
          for (const r of results) {
            if (r.status === "rejected") {
              onError?.(r.reason instanceof Error ? r.reason.message : String(r.reason))
            }
          }
        }
      } catch (e) {
        onError?.(e instanceof Error ? e.message : String(e))
      }
    },
    [active, colWidth, onError, onMoveStatus, onUpdateSchedule, paddedRange, snapDays],
  )

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <div
        ref={scrollerRef}
        className="flex-1 overflow-auto"
        data-testid="gantt-grid"
      >
        <div className="relative" style={{ minWidth: SWIMLANE_HEADER_WIDTH + totalWidth }}>
          <TimeAxis
            ticks={ticks}
            colWidth={colWidth}
            zoom={zoom}
            headerWidth={SWIMLANE_HEADER_WIDTH}
          />

          <div ref={gridRowsRef}>
            {lanes
              .filter((lane) => byStatus[lane].length > 0)
              .map((lane) => (
                <Swimlane
                  key={lane}
                  status={lane}
                  issues={byStatus[lane]}
                  colWidth={colWidth}
                  totalWidth={totalWidth}
                  headerWidth={SWIMLANE_HEADER_WIDTH}
                  range={paddedRange}
                  onSelectIssue={onSelectIssue}
                />
              ))}
          </div>

          {todayInRange && (
            <div
              data-testid="gantt-today-line"
              className="absolute top-[36px] bottom-0 pointer-events-none z-20"
              style={{
                left: SWIMLANE_HEADER_WIDTH + todayLeft,
                width: 1,
                background: "#f43f5e",
                boxShadow: "0 0 0 0.5px rgba(244,63,94,0.3)",
              }}
            >
              <div className="absolute top-0 -translate-x-1/2 px-1 py-px text-[9px] font-mono bg-rose-500 text-zinc-950">
                today
              </div>
            </div>
          )}
        </div>

        <UnscheduledTray issues={unscheduled} onSelectIssue={onSelectIssue} />
      </div>

      <DragOverlay dropAnimation={null}>
        {active ? <DragPreview active={active} colWidth={colWidth} range={paddedRange} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

/* ── DragOverlay content ──────────────────────────────────── */

function DragPreview({
  active,
  colWidth,
  range,
}: {
  active: DragData
  colWidth: number
  range: { min: string }
}) {
  if (active.kind === "bar-resize-l" || active.kind === "bar-resize-r") {
    return <div style={{ width: 2, height: ROW_HEIGHT - 4, background: "#34d399" }} />
  }
  const rect = barRect(active.issue, range, colWidth)
  const width = rect?.width ?? DEFAULT_SPAN_DAYS * colWidth
  return (
    <div
      className="h-[32px] bg-emerald-500/20 border border-emerald-500/50 text-emerald-200 text-[11px] font-mono px-2 flex items-center gap-2 shadow-lg"
      style={{ width }}
    >
      <span className="opacity-60">{active.issue.id}</span>
      <span className="truncate">{active.issue.title}</span>
    </div>
  )
}

/* ── Time Axis ─────────────────────────────────────────────── */

function TimeAxis({
  ticks,
  colWidth,
  zoom,
  headerWidth,
}: {
  ticks: string[]
  colWidth: number
  zoom: ZoomMode
  headerWidth: number
}) {
  const labelEvery = zoom === "day" ? 1 : zoom === "week" ? 1 : zoom === "month" ? 7 : 14

  return (
    <div
      className="sticky top-0 z-30 flex bg-zinc-950 border-b border-zinc-800/80"
      style={{ height: AXIS_HEIGHT }}
    >
      <div className="shrink-0 border-r border-zinc-800/80" style={{ width: headerWidth }} />
      <div className="flex">
        {ticks.map((t, i) => (
          <div
            key={t}
            className="shrink-0 border-r border-zinc-800/40 text-[9px] font-mono text-zinc-500 relative"
            style={{ width: colWidth, height: AXIS_HEIGHT }}
          >
            {i % labelEvery === 0 && (
              <span className="absolute left-1 top-1 whitespace-nowrap">
                {formatTick(t)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTick(date: string): string {
  const [, mo, d] = date.split("-")
  return `${mo}/${d}`
}

/* ── Swimlane ─────────────────────────────────────────────── */

function Swimlane({
  status,
  issues,
  colWidth,
  totalWidth,
  headerWidth,
  range,
  onSelectIssue,
}: {
  status: IssueStatus
  issues: GanttIssue[]
  colWidth: number
  totalWidth: number
  headerWidth: number
  range: { min: string; max: string }
  onSelectIssue?: (issueId: string) => void
}) {
  const accent = STATUS_ACCENT[status] ?? "#52525b"
  const label = (STATUS_LABELS as Record<string, string>)[status] ?? status

  const { setNodeRef, isOver } = useDroppable({
    id: `lane::${status}`,
    data: { type: "lane", status } satisfies LaneDropData,
  })

  return (
    <div
      data-testid={`gantt-lane-${status}`}
      className="flex border-b border-zinc-800/40"
    >
      <div
        className="shrink-0 px-3 py-2 border-r border-zinc-800/80 sticky left-0 bg-zinc-950 z-10"
        style={{ width: headerWidth, borderLeft: `2px solid ${accent}` }}
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />
          <span className="text-[10px] font-display font-semibold tracking-wider text-zinc-400 uppercase">
            {label}
          </span>
          <span className="text-[10px] font-mono text-zinc-600 ml-auto">
            {issues.length}
          </span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={`flex-1 transition-colors ${isOver ? "bg-emerald-500/5" : ""}`}
        data-testid={`gantt-lane-drop-${status}`}
      >
        {issues.map((issue) => (
          <GanttRow
            key={issue.id}
            issue={issue}
            colWidth={colWidth}
            totalWidth={totalWidth}
            range={range}
            onSelectIssue={onSelectIssue}
          />
        ))}
      </div>
    </div>
  )
}

/* ── Row ──────────────────────────────────────────────────── */

function GanttRow({
  issue,
  colWidth,
  totalWidth,
  range,
  onSelectIssue,
}: {
  issue: GanttIssue
  colWidth: number
  totalWidth: number
  range: { min: string; max: string }
  onSelectIssue?: (issueId: string) => void
}) {
  const rect = barRect(issue, { min: range.min }, colWidth)

  return (
    <div
      className="relative border-b border-zinc-900/60"
      style={{ height: ROW_HEIGHT, width: totalWidth }}
      data-testid={`gantt-row-${issue.id}`}
    >
      {rect && (
        <GanttBar
          issue={issue}
          rect={rect}
          onClick={() => onSelectIssue?.(issue.id)}
        />
      )}
    </div>
  )
}

/* ── Bar (draggable) ───────────────────────────────────────── */

function GanttBar({
  issue,
  rect,
  onClick,
}: {
  issue: GanttIssue
  rect: { left: number; width: number }
  onClick?: () => void
}) {
  const accent = STATUS_ACCENT[issue.status] ?? "#52525b"
  const isCancelled = issue.status === "cancelled"

  // Bar body drag (disabled for cancelled — readonly_dates)
  const moveDraggable = useDraggable({
    id: `bar-move::${issue.id}`,
    disabled: isCancelled,
    data: { kind: "bar-move", issueId: issue.id, issue } satisfies DragData,
  })

  const leftEdge = useDraggable({
    id: `bar-resize-l::${issue.id}`,
    disabled: isCancelled || !issue.start_date,
    data: { kind: "bar-resize-l", issueId: issue.id, issue } satisfies DragData,
  })

  const rightEdge = useDraggable({
    id: `bar-resize-r::${issue.id}`,
    disabled: isCancelled || !issue.due_date,
    data: { kind: "bar-resize-r", issueId: issue.id, issue } satisfies DragData,
  })

  return (
    <div
      data-testid={`gantt-bar-${issue.id}`}
      data-issue-id={issue.id}
      data-readonly={isCancelled ? "true" : "false"}
      className="absolute top-1 h-[32px]"
      style={{ left: rect.left, width: rect.width }}
    >
      {/* Body (move handle) */}
      <div
        ref={moveDraggable.setNodeRef}
        {...moveDraggable.attributes}
        {...moveDraggable.listeners}
        onClick={onClick}
        className={`relative h-full flex items-center gap-2 px-3 text-[11px] font-mono
          border cursor-grab active:cursor-grabbing select-none
          transition-colors duration-100
          ${moveDraggable.isDragging ? "opacity-30" : ""}
          ${isCancelled
            ? "bg-zinc-900/40 border-zinc-800/60 text-zinc-600 line-through cursor-not-allowed"
            : "bg-zinc-900/80 border-zinc-800 text-zinc-200 hover:border-zinc-700"
          }`}
        style={{ borderLeft: `3px solid ${accent}` }}
        title={`${issue.id} — ${issue.title}`}
      >
        <span className="text-zinc-500 shrink-0">{issue.id}</span>
        <span className="truncate">{issue.title}</span>
        {issue.assignee_name && (
          <span className="ml-auto text-[10px] text-zinc-500 shrink-0">
            {issue.assignee_type === "agent" ? ">" : "@"}{issue.assignee_name}
          </span>
        )}
      </div>

      {/* Left edge handle — 12 px hit target, 4 px visible */}
      {!isCancelled && issue.start_date && (
        <div
          ref={leftEdge.setNodeRef}
          {...leftEdge.attributes}
          {...leftEdge.listeners}
          data-testid={`gantt-handle-l-${issue.id}`}
          className="absolute inset-y-0 -left-1 w-3 cursor-ew-resize group"
          aria-label={`Resize start of ${issue.id}`}
        >
          <div className="absolute inset-y-1 left-1 w-1 bg-emerald-500/0 group-hover:bg-emerald-500/60 transition-colors" />
        </div>
      )}

      {/* Right edge handle */}
      {!isCancelled && issue.due_date && (
        <div
          ref={rightEdge.setNodeRef}
          {...rightEdge.attributes}
          {...rightEdge.listeners}
          data-testid={`gantt-handle-r-${issue.id}`}
          className="absolute inset-y-0 -right-1 w-3 cursor-ew-resize group"
          aria-label={`Resize end of ${issue.id}`}
        >
          <div className="absolute inset-y-1 right-1 w-1 bg-emerald-500/0 group-hover:bg-emerald-500/60 transition-colors" />
        </div>
      )}
    </div>
  )
}

/* ── Unscheduled Tray ─────────────────────────────────────── */

function UnscheduledTray({
  issues,
  onSelectIssue,
}: {
  issues: GanttIssue[]
  onSelectIssue?: (issueId: string) => void
}) {
  if (issues.length === 0) return null
  return (
    <div
      data-testid="gantt-unscheduled-tray"
      className="border-t border-zinc-800/80 p-3 bg-zinc-950 sticky bottom-0"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-display font-semibold tracking-widest uppercase text-zinc-400">
          Unscheduled
        </span>
        <span className="text-[10px] font-mono text-zinc-600">{issues.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {issues.map((issue) => (
          <UnscheduledItem key={issue.id} issue={issue} onSelect={onSelectIssue} />
        ))}
      </div>
    </div>
  )
}

function UnscheduledItem({
  issue,
  onSelect,
}: {
  issue: GanttIssue
  onSelect?: (issueId: string) => void
}) {
  const draggable = useDraggable({
    id: `unscheduled::${issue.id}`,
    data: { kind: "unscheduled", issueId: issue.id, issue } satisfies DragData,
  })
  return (
    <button
      ref={draggable.setNodeRef}
      {...draggable.attributes}
      {...draggable.listeners}
      data-testid={`gantt-unscheduled-${issue.id}`}
      data-issue-id={issue.id}
      onClick={() => onSelect?.(issue.id)}
      className={`text-left px-2 py-1 border border-zinc-800 bg-zinc-900/60 hover:border-zinc-700
        text-[11px] font-mono text-zinc-300 cursor-grab active:cursor-grabbing transition-colors max-w-[240px] truncate
        ${draggable.isDragging ? "opacity-30" : ""}`}
      title={issue.title}
    >
      <span className="text-zinc-500 mr-1.5">{issue.id}</span>
      {issue.title}
    </button>
  )
}

/* ── Empty State ──────────────────────────────────────────── */

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-3.5rem)]">
      <div className="text-center space-y-3">
        <div className="font-mono text-zinc-700 text-sm">
          {">"} no project selected
        </div>
        <div className="text-xs text-zinc-600">
          Select a project to view its timeline
        </div>
      </div>
    </div>
  )
}
