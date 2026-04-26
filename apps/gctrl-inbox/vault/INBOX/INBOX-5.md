---
id: INBOX-5
project: INBOX
status: backlog
priority: high
labels: [cli, shell]
created_by: debuggingfuture
---

# CLI commands — approve, deny, defer, batch triage

Implement gctrl-inbox shell commands for message triage. Support individual and batch actions from the terminal.

## Acceptance Criteria

- `gctrl inbox list [--status pending] [--urgency critical] [--project BOARD]` — list messages
- `gctrl inbox view <id>` — show message detail with thread context
- `gctrl inbox approve <id> [--reason "..."]` — approve permission request
- `gctrl inbox deny <id> [--reason "..."]` — deny permission request
- `gctrl inbox defer <id> [--until "2h"]` — snooze message
- `gctrl inbox dismiss <id>` — mark as dismissed
- `gctrl inbox batch approve --filter "urgency=low,project=BOARD"` — batch action
- `gctrl inbox stats` — show pending counts by urgency, project, kind
- All commands route through kernel HTTP API (never direct DB)
