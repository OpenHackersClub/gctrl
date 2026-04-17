---
id: INBOX-7
project: INBOX
status: backlog
priority: medium
labels: [web-ui, react, feed]
created_by: debuggingfuture
---

# Web UI — message feed and thread view

Build the core inbox web interface: message feed sorted by urgency, thread-grouped view with pending count badges, and message detail cards.

## Acceptance Criteria

- Message feed sorted by urgency (critical first) then timestamp
- Thread grouping: collapsible thread cards with pending count badge
- Urgency color coding: critical=rose, high=orange, medium=amber, low=sky, info=zinc
- Message card shows: source icon, kind badge, title, urgency, timestamp
- Thread detail view: all messages in thread with full context
- Individual action buttons on each message (approve, deny, dismiss)
- Design tokens match gctrl-board (zinc-950 bg, emerald accent, Chakra Petch display)
