---
id: BOARD-4
project: BOARD
status: backlog
priority: high
labels: [github-sync, driver, config]
created_by: debuggingfuture
---

# GitHub sync — project binding and config

Configure per-project binding between gctrl-board projects and GitHub repos via driver-github LKM.

## Acceptance Criteria

- CLI: `gctrl board projects bind-github --project BOARD --repo debuggingfuture/gctrl`
- Binding stored in board_projects table (github_repo column)
- Binding visible in `gctrl board projects list` and web UI ProjectSelector
- `gctrl board projects unbind-github --project BOARD` removes binding
- HTTP: `POST /api/board/projects/{id}/bind-github`, `DELETE /api/board/projects/{id}/bind-github`
