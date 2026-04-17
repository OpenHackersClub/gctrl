---
id: BOARD-9
project: BOARD
status: backlog
priority: high
labels: [github-sync, driver, outbound]
created_by: debuggingfuture
---

# GitHub sync — outbound issue and comment sync

Push gctrl-board issue creates, status changes, and comments to bound GitHub repos via driver-github.

## Acceptance Criteria

- Creating a board issue in a GitHub-bound project optionally creates a GitHub issue
- Moving a board issue to `done` closes the GitHub issue
- Moving to `cancelled` closes with "not planned" label
- Adding a board comment syncs to GitHub issue comments
- Outbound sync is async — board operations don't block on GitHub API
- Each synced issue stores `github_issue_number` and `github_url`
