---
id: BOARD-2
project: BOARD
status: backlog
priority: high
assignee: claude-code
assignee_type: agent
labels: [completion, kernel-integration]
created_by: debuggingfuture
---

# Completion logs — cross-reference kernel Tasks on issue done

When an issue transitions to `done`, auto-generate a completion record that cross-references all linked kernel Tasks, sessions, spans, and cost data. Store in `board_completion_logs` table.

## Acceptance Criteria

- Moving issue to `done` creates a completion record automatically
- Completion record includes: linked sessions, total cost, total tokens, duration, retry count
- Record references kernel Task IDs if orchestrator was used
- Viewable in issue detail panel under a new "Completion" tab
- CLI: `gctrl board issues completion <id>` shows the record
- HTTP: `GET /api/board/issues/{id}/completion` returns JSON
