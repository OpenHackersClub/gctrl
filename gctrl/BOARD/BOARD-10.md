---
id: BOARD-10
project: BOARD
status: backlog
priority: high
labels: [github-sync, driver, inbound]
created_by: debuggingfuture
---

# GitHub sync — inbound events and auto-transitions

Receive GitHub events (issue close/reopen, PR open/merge, comments) and sync back to gctrl-board via driver-github.

## Acceptance Criteria

- GitHub issue close → board issue transitions to `done`
- GitHub issue reopen → board issue transitions to `todo`
- PR opened referencing issue key → board issue transitions to `in_review`
- PR merged → board issue transitions to `done`
- GitHub comments sync to board comments with `author_type: "human"`
- Conflict resolution: last-write-wins with event timestamps
- Sync latency < 30s from GitHub event (webhook or polling)
