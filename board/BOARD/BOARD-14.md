---
id: BOARD-14
project: BOARD
status: backlog
priority: none
labels: [enhancement, web-ui]
created_by: debuggingfuture
github_issue: 6
---

# Add navigation menu bar with Inbox page

gctl-board web UI should have a navigation menu bar that allows switching between pages:

- **Board** (`/projects/:key`) — existing kanban view
- **Inbox** (`/inbox`) — view for gctl-inbox messages, threads, and actions

## Requirements

- Add a persistent nav/menu bar (sidebar or top-level tabs) to the board web UI
- Nav links: Board (kanban), Inbox (messages/threads)
- Active state highlighting for current page
- Inbox page: list messages with urgency, kind, status filters
- Inbox page: view message threads
- Inbox page: approve/deny/acknowledge actions inline
- SPA routing: `/inbox` and `/inbox/:threadId` routes
- Kernel API integration: use existing `/api/inbox/*` routes
