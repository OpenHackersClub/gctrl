---
id: INBOX-4
project: INBOX
status: backlog
priority: high
labels: [budget, guardrail, alerts]
created_by: debuggingfuture
---

# Budget alert handling — cost threshold warnings

Route budget threshold events from guardrails to inbox. Support warning (approaching limit) and exceeded (hard stop) alert types with configurable thresholds.

## Acceptance Criteria

- `budget_warning` messages created at 80% of session/project cost budget
- `budget_exceeded` messages created at 100% with urgency `critical`
- Message payload includes: current cost, budget limit, percentage, session/project context
- Warning messages are `info` urgency, exceeded are `critical`
- Human can acknowledge (dismiss) or increase budget via action
- Budget increase action updates guardrail config via kernel API
- Grouped by project thread for batch review
