---
id: INBOX-2
project: INBOX
status: backlog
priority: high
labels: [threading, grouping]
created_by: debuggingfuture
---

# Thread auto-grouping by context

Implement automatic thread grouping when new messages arrive. Messages are grouped by context priority: issue_key > session_id > project_key > agent_name.

## Acceptance Criteria

- New message with `context.issue_key` joins/creates thread keyed by `(issue, BACK-42)`
- New message with `context.session_id` (no issue) joins `(session, sess_abc)`
- New message with `context.project_key` only joins `(project, BACK)`
- New message with `context.agent_name` only joins `(agent, claude-code)`
- Thread `pending_count` increments on new message, decrements on action
- Thread `latest_urgency` updates to max urgency of pending messages
- Duplicate detection: identical source+kind+context within 5 minutes increments `duplicate_count`
