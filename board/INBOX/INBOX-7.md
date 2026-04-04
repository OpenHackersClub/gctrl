---
id: INBOX-7
project: INBOX
status: backlog
priority: medium
labels: [web-ui, react]
created_by: debuggingfuture
---

# Web UI — feed, thread view, batch action bar

Build the gctl-inbox web interface: message feed with urgency indicators, thread-grouped view, and batch action toolbar.

## Acceptance Criteria

- Message feed sorted by urgency then timestamp
- Thread grouping: collapsible thread cards with pending count badge
- Urgency color coding: critical=rose, high=orange, medium=amber, low=sky, info=zinc
- Message card shows: source icon, kind badge, title, urgency, timestamp, action buttons
- Thread detail view: all messages in thread with full context
- Batch action bar: select multiple messages, approve/deny/dismiss all
- Filter sidebar: by status, urgency, kind, project, source
- Real-time updates via SSE when available
- Keyboard shortcuts: j/k navigate, a approve, d deny, x dismiss
- Design tokens match gctl-board (zinc-950 bg, emerald accent, Chakra Petch display)
