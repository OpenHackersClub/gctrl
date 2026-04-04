---
id: INBOX-6
project: INBOX
status: backlog
priority: high
labels: [http-api, kernel]
created_by: debuggingfuture
---

# HTTP API routes for inbox CRUD and actions

Implement kernel HTTP API endpoints for gctl-inbox under `/api/inbox/*`.

## Acceptance Criteria

- `GET /api/inbox/messages` — list with filters (status, urgency, kind, project_key, thread_id)
- `GET /api/inbox/messages/{id}` — view single message with thread context
- `POST /api/inbox/messages` — create message (for kernel/driver producers)
- `GET /api/inbox/threads` — list threads with pending counts
- `GET /api/inbox/threads/{id}` — view thread with all messages
- `POST /api/inbox/messages/{id}/action` — record human action (approve, deny, defer, dismiss, delegate)
- `GET /api/inbox/subscriptions` — list user subscriptions
- `POST /api/inbox/subscriptions` — create/update subscription
- `GET /api/inbox/stats` — aggregate counts by urgency, kind, project
- All endpoints use axum handlers with proper error responses
- Integration tests with `tower::ServiceExt::oneshot`
