---
id: BOARD-8
project: BOARD
status: backlog
priority: low
labels: [real-time, ipc]
created_by: debuggingfuture
---

# Real-time updates via kernel IPC events

Add real-time board updates using kernel IPC (SSE or WebSocket). When an agent moves an issue, adds a comment, or links a session, the web UI updates without polling.

## Acceptance Criteria

- Web UI subscribes to kernel IPC event stream
- Issue status changes reflected in real-time on kanban board
- New comments appear without refresh
- Session linking updates cost/token counts live
- Agent assignment shows immediately
- Reconnection logic on connection drop
- No polling — pure event-driven updates
