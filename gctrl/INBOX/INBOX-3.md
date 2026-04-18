---
id: INBOX-3
project: INBOX
status: backlog
priority: urgent
labels: [permission, guardrail, kernel-integration]
created_by: debuggingfuture
---

# Permission gate flow — guardrail approval and denial

Implement the end-to-end permission gate: guardrail event -> inbox message -> human decision -> kernel IPC -> orchestrator resumes or terminates session.

## Acceptance Criteria

- Guardrail `permission_request` events create inbox messages automatically
- Message includes: action description, risk level, session context, agent identity
- Human can approve, deny, or delegate via CLI or web UI
- Approve action resumes the paused session via kernel IPC
- Deny action terminates the session with reason
- Delegate action re-routes to another user's inbox
- Full audit trail in inbox_actions table
- Agent resume latency < 5s after approval
