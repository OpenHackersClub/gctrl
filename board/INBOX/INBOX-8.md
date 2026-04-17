---
id: INBOX-8
project: INBOX
status: backlog
priority: high
labels: [kernel-ipc, integration, guardrail]
created_by: debuggingfuture
---

# Kernel IPC integration — guardrail and orchestrator event routing

Wire gctrl-inbox into the kernel IPC event system. Guardrail events auto-create inbox messages. Inbox approval actions route back to the orchestrator to resume/terminate sessions.

## Acceptance Criteria

- Kernel guardrail events (`permission_gate`, `budget_threshold`) auto-create inbox messages
- Orchestrator session events (`paused`, `failed`, `completed`) create status_update messages
- Board events (`issue_assigned`, `issue_blocked`) create relevant inbox messages
- Inbox `approve` action sends `PermissionGranted` IPC event to orchestrator
- Inbox `deny` action sends `PermissionDenied` IPC event to orchestrator
- Subscription filters control which events enter a user's inbox
- Event routing is async — inbox creation does not block the event source
- Integration tests with mock IPC channel
