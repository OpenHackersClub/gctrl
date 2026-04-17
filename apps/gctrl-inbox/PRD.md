# gctrl-inbox — Human Action Center

> Unified inbox for agent requests, system alerts, and external notifications — grouped by context, designed for batch triage.

## Problem

1. **Permission requests scatter** — agents hit guardrail gates (force-push, budget exceeded, destructive command) and block silently. No central place to see pending approvals.
2. **Notification fatigue** — status updates, PR comments, CI failures, eval scores arrive from multiple sources (kernel events, GitHub, Linear) with no grouping or priority.
3. **Context switching per action** — human must open board, find issue, check session, read trace, then decide. Each approval is a standalone mental context switch.
4. **No batch action model** — granting 5 similar permissions requires 5 separate interactions. No way to triage a set of related requests and act at once.
5. **Async gap** — agents are designed to work autonomously but periodically need human input. No structured channel for this; requests get lost in Slack threads or terminal output.
6. **No audit trail for decisions** — when a human approves a destructive action, there's no record of who approved what and why.

## Our Take

> The bottleneck in human+agent collaboration is not response time — it's **decision throughput**. Humans shouldn't be on-call for every agent micro-decision. They should triage by context, batch related decisions, and act when ready.

gctrl-inbox is the **`/dev/tty`** of the gctrl OS — the structured I/O channel between agents (processes) and humans (operators). Just as Unix processes can `read(stdin)` to request input and write to `syslog` for notifications, gctrl agents generate messages that flow into the inbox, grouped by the context the human is already thinking about.

The key insight: **group by context, not by time**. A flat chronological notification feed forces linear processing. Grouping by issue, project, or agent lets humans build mental context once and resolve everything related in one pass.

## Principles

1. **Context-first grouping** — messages auto-group by issue, session, project, or agent. The human sees threads, not a flat feed.
2. **Batch is the default** — selecting and acting on multiple items at once is the primary interaction, not an afterthought.
3. **Async by design** — agents MUST NOT block waiting for inbox response. They continue with other work or enter a `waiting` state that the orchestrator can manage. Humans act when ready.
4. **Real-time delivery, async consumption** — messages arrive immediately via kernel IPC. Humans are not expected to respond in real-time.
5. **Actions are auditable** — every human decision (approve, deny, defer, delegate) is recorded with actor, timestamp, and optional rationale.
6. **Board is the companion** — inbox threads link to board issues. Acting on an inbox item can trigger board transitions. The inbox is "what needs my attention now"; the board is "what's the plan."
7. **Urgency, not importance** — inbox handles time-sensitive requests (permission gates, blocking alerts). Strategic prioritization belongs on the board.
8. **Minimal noise** — subscriptions and filters control what enters the inbox. Status updates that don't require action are opt-in, not default.

## Target Users

### Primary: Developer Operating Agents

| Need | Surface | Solution |
|------|---------|---------|
| See what agents need from me | CLI / Web UI | Inbox feed grouped by context |
| Approve permission request | CLI / Web UI | `gctrl inbox approve <id>` or batch-approve in UI |
| Deny destructive action | CLI / Web UI | `gctrl inbox deny <id> --reason "too risky"` |
| Review all requests for an issue | Web UI | Thread view filtered by issue key |
| Batch-approve similar requests | Web UI | Multi-select + batch action |
| Snooze non-urgent items | Both | Defer with duration (`--until 2h`) |
| See what I approved today | CLI | `gctrl inbox actions --actor me --since today` |
| Know why an agent is waiting | Both | Message shows context: session, issue, what agent tried to do |

### Secondary: Team Lead Reviewing Decisions

| Need | Surface | Solution |
|------|---------|---------|
| Audit who approved what | CLI | `gctrl inbox actions --since 7d` |
| See unresolved blockers across team | Web UI | Inbox dashboard with pending count by project |
| Delegate items to team members | Web UI | Assign inbox thread to another human |
| Understand decision patterns | CLI | `gctrl inbox stats` — approval rate, avg response time, common deny reasons |

## Use Cases

### UC-1: Permission Gate Approval

**Problem:** Agent working on BACK-42 attempts `git push --force` to a protected branch. Kernel guardrail denies the action and the orchestrator transitions the session to `Paused`.

**Solution:**
1. Kernel emits `GuardrailDenied` event with context (session, issue, command, risk level, policy name)
2. Kernel emits `SessionPaused` event with pause reason `guardrail_denied`
3. Inbox (subscribed to these events) creates a message in the BACK-42 thread with urgency `high`
4. Human opens inbox, sees "BACK-42: Agent requests force-push to `feature/auth`"
5. Human reviews context (why agent wants to force-push, what changed), clicks Approve or Deny
6. Inbox emits `PermissionGranted` / `PermissionDenied` event via kernel IPC
7. Orchestrator (subscribed to permission events) resumes or terminates the session

**Success metric:** Human can resolve permission gate within 1 interaction (no context switching to separate tools).

### UC-2: Budget Threshold Alert

**Problem:** Agent session on BACK-15 reaches 80% of cost budget. Guardrail emits warning but doesn't block yet.

**Solution:**
1. Kernel emits `BudgetWarning` event
2. Inbox creates message in BACK-15 thread with urgency `medium`
3. Human reviews cost breakdown in thread (linked to session cost analytics)
4. Human either acknowledges (let it continue) or pauses the session
5. If session later exceeds 100%, urgency escalates to `critical` and agent blocks

**Success metric:** Human aware of cost trajectory before hard limit hit.

### UC-3: Batch Triage After Focus Session

**Problem:** Developer was in a 2-hour focus session. During that time, 3 agents generated 12 messages across 4 issues.

**Solution:**
1. Human opens inbox, sees 12 unread grouped into 4 threads (one per issue)
2. Threads sorted by urgency: 2 permission gates (high), 1 budget warning (medium), 1 status update (low)
3. Human opens BACK-42 thread: 3 permission requests for similar file operations. Selects all → batch approve
4. Opens BACK-15 thread: budget warning. Acknowledges
5. Opens BACK-8 thread: agent completed and needs eval score. Human defers to later
6. Status update thread: auto-dismissed

**Success metric:** 12 messages triaged and acted on in <3 minutes.

### UC-4: Agent Question / Clarification

**Problem:** Agent working on BACK-30 encounters ambiguous acceptance criteria. Needs human guidance before proceeding.

**Solution:**
1. Agent emits `ClarificationRequested` with question text and relevant context references
2. Inbox creates message in BACK-30 thread with urgency `medium`
3. Human reads question, types reply in inbox thread
4. Reply delivered to agent's context via kernel IPC
5. Agent resumes with clarification

**Success metric:** Structured Q&A without leaving the inbox.

### UC-5: External Notification Routing

**Problem:** GitHub PR review requested on a PR linked to BACK-42. Notification arrives via driver-github.

**Solution:**
1. Driver-github detects PR review request event
2. Kernel creates inbox message linked to BACK-42 thread
3. Human sees it alongside other BACK-42 messages — permission requests, agent status
4. Human can act on everything related to BACK-42 in one pass

**Success metric:** External notifications grouped with internal context, not in a separate silo.

## What We're Building

### Message Model

A **message** is an immutable notification or request delivered to the inbox:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `VARCHAR PK` | UUID |
| `thread_id` | `VARCHAR NOT NULL` | Groups related messages |
| `source` | `VARCHAR NOT NULL` | Origin: `kernel`, `guardrail`, `agent`, `driver-github`, `driver-linear`, `board` |
| `kind` | `VARCHAR NOT NULL` | `permission_request`, `budget_warning`, `budget_exceeded`, `clarification`, `status_update`, `review_request`, `agent_question`, `eval_request`, `custom` |
| `urgency` | `VARCHAR NOT NULL` | `critical`, `high`, `medium`, `low`, `info` |
| `title` | `VARCHAR NOT NULL` | Human-readable summary |
| `body` | `VARCHAR` | Detail text (markdown) |
| `context` | `JSON NOT NULL` | Structured context: `{ session_id?, issue_key?, project_key?, agent_name?, command?, cost_usd? }` |
| `status` | `VARCHAR NOT NULL` | `pending`, `acted`, `dismissed`, `snoozed`, `expired` |
| `requires_action` | `BOOLEAN NOT NULL` | Whether human action is needed (vs. informational) |
| `payload` | `JSON` | Structured data per `kind` (e.g., command, diff_preview, cost_breakdown). UI renders rich components from this. |
| `duplicate_count` | `INTEGER DEFAULT 0` | Incremented when dedup suppresses a duplicate message |
| `snoozed_until` | `VARCHAR` | ISO timestamp if snoozed |
| `expires_at` | `VARCHAR` | Auto-expire for time-sensitive requests |
| `created_at` | `VARCHAR NOT NULL` | ISO timestamp |
| `updated_at` | `VARCHAR NOT NULL` | ISO timestamp, updated on every status transition |

### Thread Model

A **thread** groups messages sharing context:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `VARCHAR PK` | UUID |
| `context_type` | `VARCHAR NOT NULL` | `issue`, `session`, `project`, `agent`, `custom` |
| `context_ref` | `VARCHAR NOT NULL` | The reference value (issue key, session ID, project key, agent name) |
| `title` | `VARCHAR NOT NULL` | Thread title (auto-generated from context, editable) |
| `project_key` | `VARCHAR` | Owning project (for board integration) |
| `pending_count` | `INTEGER DEFAULT 0` | Cached count of actionable messages |
| `latest_urgency` | `VARCHAR DEFAULT 'info'` | Highest urgency among pending messages |
| `created_at` | `VARCHAR NOT NULL` | ISO timestamp |
| `updated_at` | `VARCHAR NOT NULL` | ISO timestamp |

**Auto-grouping rules:**
1. Message with `context.issue_key` → thread keyed by `(issue, issue_key)`
2. Message with `context.session_id` but no issue → thread keyed by `(session, session_id)`
3. Message with `context.project_key` but no issue/session → thread keyed by `(project, project_key)`
4. Message with `context.agent_name` only → thread keyed by `(agent, agent_name)`
5. Thread created on first message; subsequent messages join existing thread

### Action Model

An **action** records a human decision:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `VARCHAR PK` | UUID |
| `message_id` | `VARCHAR NOT NULL` | Target message |
| `thread_id` | `VARCHAR NOT NULL` | Parent thread (denormalized for query efficiency) |
| `actor_id` | `VARCHAR NOT NULL` | Human who acted |
| `actor_name` | `VARCHAR NOT NULL` | Human-readable name |
| `action_type` | `VARCHAR NOT NULL` | `approve`, `deny`, `acknowledge`, `defer`, `delegate`, `escalate`, `reply` |
| `reason` | `VARCHAR` | Optional rationale |
| `metadata` | `JSON` | Action-specific data: `{ delegate_to?, snooze_until?, reply_text? }` |
| `created_at` | `VARCHAR NOT NULL` | ISO timestamp |

### Subscription Model

A **subscription** controls what enters a user's inbox:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `VARCHAR PK` | UUID |
| `user_id` | `VARCHAR NOT NULL` | Subscriber |
| `filter_type` | `VARCHAR NOT NULL` | `project`, `issue`, `agent`, `kind`, `urgency_gte` |
| `filter_value` | `VARCHAR NOT NULL` | Match value (project key, agent name, message kind, urgency level) |
| `enabled` | `BOOLEAN DEFAULT true` | Active toggle |
| `created_at` | `VARCHAR NOT NULL` | ISO timestamp |

**Default subscriptions (auto-created):**
- All `permission_request` and `budget_exceeded` messages (cannot be disabled)
- All messages for issues assigned to the user
- All `clarification` and `agent_question` messages

### Board Integration

All cross-app data flows through **kernel IPC events** (per Invariant #2 in `specs/principles.md`). gctrl-inbox and gctrl-board MUST NOT call each other's APIs directly or join each other's tables.

1. **Issue detail shows inbox count** — board reads inbox pending count via kernel HTTP API (`GET /api/inbox/threads?context_type=issue&context_ref=BACK-42`), not a direct table join
2. **Thread links to issue** — inbox thread for BACK-42 links to board issue view via `context_ref` (the issue key). Inbox enriches display by fetching issue metadata from kernel API (`GET /api/board/issues/{key}`)
3. **Actions emit kernel IPC events** — approving a permission request emits a `PermissionGranted` kernel event. Board subscribes to this event and creates a `board_event` on the linked issue. Inbox does not write to board tables.
4. **Board emits review requests via kernel IPC** — `gctrl board request-review BACK-42` emits a `ReviewRequested` kernel event. Inbox subscribes and creates a `review_request` message. Board does not call inbox API.
5. **Issue closure archives thread** — board emits `IssueClosed` kernel event. Inbox subscribes and auto-archives the matching thread.

### Kernel Integration

The kernel MUST NOT create inbox messages directly (per Invariant #4: kernel MUST NOT make assumptions about applications). Instead, the kernel emits domain events via IPC. The inbox app subscribes to relevant events and creates its own messages.

> **Note:** Kernel IPC (event bus) is [planned]. Until implemented, the inbox polls kernel state via HTTP API or uses a webhook/callback registration mechanism. See Open Question #6.

1. **Guardrail events → Inbox subscription** — when a guardrail policy returns `Deny`, the kernel emits a `GuardrailDenied` event (with session, command, policy name). The inbox subscribes and creates a `permission_request` message if the policy indicates human review is appropriate.
2. **Orchestrator events → Inbox subscription** — when the orchestrator transitions a session to `Paused` (the existing state for human-gated holds), the kernel emits a `SessionPaused` event. The inbox subscribes and creates an `agent_question` or `permission_request` message based on the pause reason.
3. **Inbox → Kernel IPC** — when human approves, inbox emits `PermissionGranted` event via kernel IPC; orchestrator subscribes and resumes the session. On deny, inbox emits `PermissionDenied`.
4. **Alert rules** — kernel `alert_rules` can target inbox as a delivery channel (alongside existing alert mechanisms)

### Driver Integration

Drivers emit kernel events. Inbox subscribes to driver events and creates messages — drivers do not call inbox API directly.

1. **driver-github events → Inbox** — PR review requests, CI failures, issue comments emit kernel events. Inbox subscribes and creates messages grouped by linked board issue.
2. **driver-linear → Inbox** — [deferred] status changes, comments, mentions
3. **driver-slack → Inbox** — [deferred] direct messages, mentions in channels

### Action Idempotency

Actions MUST only be recorded against messages with status `pending`. Attempting to act on a non-pending message MUST return an error with the current status. Batch actions MUST validate each message independently and report per-message results (success/skipped with reason). Concurrent actions on the same message use first-writer-wins: the first action transitions the status; subsequent attempts fail with "already acted."

### Message Deduplication

To prevent flood scenarios (e.g., runaway agent hitting the same guardrail in a loop), the inbox MUST deduplicate messages with the same `kind`, `source`, and `context` within a configurable time window (default: 60s). Duplicate messages increment a `duplicate_count` on the original rather than creating new messages.

### Real-Time Delivery

1. Messages created by the inbox app when it observes kernel events (event-driven, not polled — except during IPC bootstrap; see Kernel Integration note)
2. Web UI receives updates via Server-Sent Events (SSE) from inbox HTTP endpoint. SSE clients authenticate via the same mechanism as other API calls. Optional query params filter events (`?project=BACK&urgency_gte=high`)
3. CLI polls on demand (`gctrl inbox list`) — no background daemon required
4. Thread `pending_count` and `latest_urgency` updated atomically on message insert/action. On action, `latest_urgency` is recomputed as MAX urgency of remaining `pending` messages (resets to `info` when no pending messages remain)

### Surfaces

#### CLI (`gctrl inbox`)

```
gctrl inbox count [--urgency high]
gctrl inbox list [--urgency high] [--kind permission_request] [--project BACK] [--pending]
gctrl inbox view <message-id>
gctrl inbox thread <thread-id>
gctrl inbox approve <message-id> [--reason "..."]
gctrl inbox deny <message-id> --reason "..."
gctrl inbox acknowledge <message-id>
gctrl inbox defer <message-id> --until <duration|timestamp>
gctrl inbox delegate <message-id> --to <user>
gctrl inbox reply <message-id> --body "..."
gctrl inbox batch-approve <message-id>... [--reason "..."]
gctrl inbox actions [--actor <user>] [--since <duration>]
gctrl inbox stats [--since <duration>]
gctrl inbox subscribe --filter <type>=<value>
gctrl inbox unsubscribe <subscription-id>
gctrl inbox subscriptions
```

#### HTTP API (`/api/inbox/*`)

```
GET    /api/inbox/messages          — List messages (query params: urgency, kind, project, status, limit)
GET    /api/inbox/messages/{id}     — Get message
POST   /api/inbox/messages          — Create message (internal: kernel/drivers use this)
GET    /api/inbox/threads           — List threads (query params: project, context_type, has_pending)
GET    /api/inbox/threads/{id}      — Get thread with messages
POST   /api/inbox/actions           — Record action (approve/deny/defer/etc.)
GET    /api/inbox/actions           — List actions (query params: actor, since, thread)
POST   /api/inbox/batch-action      — Batch action on multiple messages
GET    /api/inbox/stats             — Inbox statistics
GET    /api/inbox/sse               — Server-Sent Events stream for real-time updates
POST   /api/inbox/subscriptions     — Create subscription
GET    /api/inbox/subscriptions     — List subscriptions
DELETE /api/inbox/subscriptions/{id} — Remove subscription
```

#### Web UI

1. **Inbox feed** — threads sorted by urgency, then recency. Pending count badges. Filter sidebar (by project, urgency, kind)
2. **Thread view** — chronological message list with inline action buttons. Context panel showing linked issue, session, cost
3. **Batch action bar** — appears on multi-select. Approve all, deny all, defer all
4. **Board integration** — inbox widget on board issue detail panel showing pending messages for that issue
5. **Notification badge** — persistent count of pending actionable messages in app header

## Roadmap

### M0: Core Messaging (P0)

| Feature | Issue | Priority | Acceptance Criteria |
|---------|-------|----------|-------------------|
| Message storage (DuckDB `inbox_*` tables) | INBOX-1 | P0 | Messages persist, query by urgency/kind/status |
| Thread auto-grouping | INBOX-2 | P0 | Messages auto-group by issue key, session, project |
| Action recording | INBOX-3 | P0 | Actions recorded with actor, type, timestamp, reason |
| CLI: list, view, approve, deny | INBOX-4 | P0 | All core CLI commands functional |
| HTTP API: CRUD + actions | INBOX-5 | P0 | All core routes return correct responses |
| Guardrail event → Inbox subscription | INBOX-6 | P0 | `GuardrailDenied` event creates inbox message; approval emits `PermissionGranted` |
| Kernel IPC: PermissionGranted/Denied | INBOX-7 | P0 | Orchestrator subscribes and resumes/terminates session |
| Action idempotency | INBOX-7b | P0 | Actions only on `pending` messages; concurrent first-writer-wins |
| Message deduplication | INBOX-7c | P0 | Same kind+source+context within 60s deduped |

### M1: Batch & Board (P0)

| Feature | Issue | Priority | Acceptance Criteria |
|---------|-------|----------|-------------------|
| Batch actions (CLI + API) | INBOX-8 | P0 | `batch-approve` resolves multiple messages atomically |
| Board integration: pending count on issues | INBOX-9 | P0 | Issue cards show inbox badge |
| Board integration: thread ↔ issue linking | INBOX-10 | P0 | Inbox thread navigates to issue and vice versa |
| Snooze / defer with expiry | INBOX-11 | P1 | Snoozed messages reappear after duration |
| Subscription management | INBOX-12 | P1 | Users control what enters their inbox |

### M2: Web UI (P1)

| Feature | Issue | Priority | Acceptance Criteria |
|---------|-------|----------|-------------------|
| Inbox feed view | INBOX-13 | P1 | Threads displayed with urgency sorting and filters |
| Thread detail view | INBOX-14 | P1 | Messages with inline actions, context panel |
| Batch action bar | INBOX-15 | P1 | Multi-select with batch approve/deny/defer |
| SSE real-time updates | INBOX-16 | P1 | New messages appear without page refresh |
| Board issue detail widget | INBOX-17 | P1 | Inbox panel on issue detail page |

### M3: External & Advanced (P2)

| Feature | Issue | Priority | Acceptance Criteria |
|---------|-------|----------|-------------------|
| driver-github notifications | INBOX-18 | P2 | PR reviews, CI failures routed to inbox |
| Agent question/reply flow | INBOX-19 | P2 | Agent asks question, human replies, agent receives |
| Delegation | INBOX-20 | P2 | Assign inbox thread to another user |
| Action analytics | INBOX-21 | P2 | Stats: approval rate, response time, common patterns |
| Message expiry | INBOX-22 | P2 | Time-sensitive messages auto-expire |

## Non-Goals

1. **Chat** — inbox is not a real-time chat system. Messages flow one direction (source → human) with structured actions, not free-form conversation. Agent Q&A (UC-4) uses structured reply, not chat.
2. **Notification delivery** — inbox does not push to email, SMS, or mobile. It is a pull-based feed with optional SSE for web UI. External notification routing (e.g., Slack webhook) is a driver concern.
3. **Approval workflows** — inbox does not enforce multi-step approval chains (e.g., "requires 2 approvers"). Single human acts; audit trail provides accountability.
4. **Priority scoring** — inbox uses simple urgency levels set by the source. ML-based priority ranking is not in scope.
5. **Message editing** — messages are immutable once created. Corrections arrive as new messages.

## Success Criteria

1. **Permission gate resolved in ≤2 interactions** — human sees request, acts on it. No context switching to other tools.
2. **Batch triage: 10+ messages in <3 minutes** — grouping by context eliminates per-message context switching.
3. **100% audit coverage** — every action recorded with actor, timestamp, and optional reason.
4. **Board integration: zero-click context** — inbox thread shows issue status, session cost, and agent state without navigation.
5. **Agent resume latency <5s** — from human approval to agent resuming work (kernel IPC, not human response time).

## Open Questions

1. **Thread merging** — if an agent session spans multiple issues, should messages appear in multiple threads or a merged view? **Leaning:** duplicate into each issue thread with cross-reference.
2. **Notification escalation** — should unresolved critical messages escalate after N minutes (e.g., re-notify, auto-deny)? **Leaning:** yes, configurable per urgency level via kernel alert rules.
3. **Multi-user inbox** — in team mode, does each user see their own filtered inbox, or is there a shared team inbox? **Leaning:** shared team inbox with per-user subscriptions for filtering. Delegation handles routing to specific humans. Add `team_id` to subscriptions and `inbox_teams` table in a future milestone.
4. **Offline agents** — if an agent's session has ended by the time human acts, what happens to the approval? **Leaning:** action recorded but marked `stale`; orchestrator can re-dispatch if needed. When snoozed messages return to `pending`, the system SHOULD check session liveness and transition to `expired` if session ended.
5. **Thread archival** — when a board issue moves to `done`, should its inbox thread auto-archive? **Leaning:** yes, with "show archived" toggle.
6. **Kernel IPC bootstrap** — kernel IPC (event bus) is planned but not yet implemented. Until available, inbox can: (a) poll kernel HTTP API on a timer for guardrail/session state changes, or (b) register a webhook callback URL that the kernel calls. **Leaning:** (b) webhook callback as a stepping stone to full IPC. Kernel adds a `POST /api/webhooks` registration endpoint; inbox registers for `GuardrailDenied`, `SessionPaused`, etc.
7. **`clarification` vs `agent_question`** — these kinds overlap. **Leaning:** merge into single `agent_question` kind with a `question_type` field in `context` JSON distinguishing spec-ambiguity from general questions.
8. **Data retention** — messages in terminal status older than `inbox_retention_days` (default: 90) SHOULD be purged. Actions retained for `inbox_audit_retention_days` (default: 365). **Leaning:** scheduled cleanup job, configurable per-instance.
