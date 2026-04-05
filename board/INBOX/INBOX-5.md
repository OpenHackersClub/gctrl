---
id: INBOX-5
project: INBOX
status: backlog
priority: high
labels: [cli, shell]
created_by: debuggingfuture
---

# CLI commands — approve, deny, defer, batch triage

Implement gctl-inbox shell commands for message triage. Support individual and batch actions from the terminal.

## Acceptance Criteria

- `gctl inbox list [--status pending] [--urgency critical] [--project BOARD]` — list messages
- `gctl inbox view <id>` — show message detail with thread context
- `gctl inbox approve <id> [--reason "..."]` — approve permission request
- `gctl inbox deny <id> [--reason "..."]` — deny permission request
- `gctl inbox defer <id> [--until "2h"]` — snooze message
- `gctl inbox dismiss <id>` — mark as dismissed
- `gctl inbox batch approve --filter "urgency=low,project=BOARD"` — batch action
- `gctl inbox stats` — show pending counts by urgency, project, kind
- All commands route through kernel HTTP API (never direct DB)
