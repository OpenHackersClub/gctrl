---
id: INBOX-1
project: INBOX
status: backlog
priority: urgent
labels: [storage, kernel, foundation]
created_by: debuggingfuture
---

# Core message storage — inbox_messages and inbox_threads tables

Implement the foundational DuckDB tables for gctl-inbox: `inbox_messages`, `inbox_threads`, `inbox_actions`, `inbox_subscriptions`. Add CRUD operations in gctl-storage.

## Acceptance Criteria

- `inbox_messages` table with: id, thread_id, source, kind, urgency, status, requires_action, context (JSON), payload, duplicate_count, snoozed_until, expires_at, created_at
- `inbox_threads` table with: id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
- `inbox_actions` table with: id, message_id, thread_id, actor_id, actor_name, action_type, reason, metadata, created_at
- `inbox_subscriptions` table with: id, user_id, filter_type, filter_value, enabled
- Rust CRUD functions in DuckDbStore with `inbox_` prefix
- 100% test coverage for all CRUD operations
- Message kinds: permission_request, budget_warning, budget_exceeded, agent_question, clarification, review_request, status_update
