---
id: BOARD-4
project: BOARD
status: backlog
priority: high
labels: [github-sync, driver]
created_by: debuggingfuture
---

# GitHub bidirectional sync via driver-github

Bidirectional sync between gctl-board issues and GitHub Issues using the kernel's driver-github LKM. Per-project binding to a GitHub repo.

## Acceptance Criteria

- CLI: `gctl board projects bind-github --project BOARD --repo debuggingfuture/gctrl`
- Creating a board issue optionally creates a GitHub issue
- GitHub issue status changes (close, reopen) sync back to board
- PR open/merge events auto-transition board issues
- Comments sync bidirectionally
- Conflict resolution: last-write-wins with event timestamps
- Sync within 30s of external event (webhook or polling)
