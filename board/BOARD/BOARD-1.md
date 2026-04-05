---
id: BOARD-1
project: BOARD
status: in_progress
priority: high
assignee: claude-code
assignee_type: agent
labels: [dogfood, dispatch, web-ui]
created_by: debuggingfuture
---

# Agent dispatch on drag — orchestrate agents from kanban

When a user drags an issue to `in_progress` on the kanban board, trigger agent orchestration:

1. Call `/api/team/recommend` with the issue's labels to get persona recommendations
2. Show a dispatch dialog with recommended personas
3. User selects personas, confirms dispatch
4. Call `/api/team/render` with selected personas + issue context
5. Auto-assign the issue to the dispatched agent persona
6. Link the resulting session to the issue for cost tracking

## Acceptance Criteria

- Dragging to `in_progress` opens a dispatch confirmation dialog
- Dialog shows recommended personas from `/api/team/recommend`
- User can select/deselect personas before dispatching
- Dispatching calls `/api/team/render` and assigns the issue
- Skipping dispatch moves the issue without agent orchestration
- Agent assignment updates the issue card in real-time
