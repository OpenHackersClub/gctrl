---
id: INBOX-9
project: INBOX
status: backlog
priority: medium
labels: [web-ui, react, batch]
created_by: debuggingfuture
---

# Web UI — batch action bar and filters

Add batch triage capabilities to the inbox web UI: multi-select messages, bulk approve/deny/dismiss, and filter sidebar.

## Acceptance Criteria

- Checkbox on each message card for multi-select
- Batch action bar appears when 1+ messages selected (approve all, deny all, dismiss all)
- Filter sidebar: by status (pending, acted, dismissed), urgency, kind, project, source
- Keyboard shortcuts: j/k navigate, a approve, d deny, x dismiss, space toggle select
- Batch action count shown in action bar ("3 selected — Approve All")
- Select-all / deselect-all toggle per thread
