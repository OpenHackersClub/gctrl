---
id: BOARD-12
project: BOARD
status: backlog
priority: medium
labels: [auto-transition, kernel-ipc]
created_by: debuggingfuture
---

# Auto-transitions from kernel IPC events

Wire board status transitions to kernel events: agent session references issue key → link + move to `in_progress`; PR open → `in_review`; PR merge → `done`; blockers resolved → unblock.

## Acceptance Criteria

- Kernel session start referencing issue key auto-links session and moves to `in_progress`
- PR open event (from driver-github) moves linked issue to `in_review`
- PR merge event moves linked issue to `done`
- All blocked_by issues resolved → auto-unblock the blocked issue
- Auto-transitions emit board events with `actor_type: "system"`
- Transitions respect forward-only rule (no backward moves)
- Event routing is async via kernel IPC (does not block the event source)
