# gctrl-inbox Roadmap

Storage is SQLite (kernel source of truth). The board SPA already has a full
`/inbox` surface; slices below close the gap between "scaffolded" and "fully
operational." See `WORKFLOW.md` for the message lifecycle and HTTP API spec,
and `PRD.md` for goals and use cases.

## Slices

| # | Slice | Priority | Status | Issue |
|---|-------|----------|--------|-------|
| 1 | Fix: batch-action path mismatch in web client | P0 | open | #208 |
| 2 | Dedup — flood guard for runaway agents | P0 | open | #209 |
| 3 | Claude Code inbox hook — agent writes to inbox on stop/deny | P1 | open | #210 |
| 4 | InboxEvent on EventBus + SSE endpoint + live UI | P1 | open | #211 |
| 5 | Bidirectional file mirror — Obsidian vault-gctrl-inbox | P1 | open | #212 |
| 6 | `/wait` long-poll + guardrail/orchestrator auto-emit | P2 | open | #74 |

## Slice Descriptions

### S1 — Fix: batch-action path mismatch (P0)

Client called `/api/inbox/actions/batch`; kernel registers `/api/inbox/batch-action`.
Batch-approve is broken on both web and desktop. One-line fix in `client.ts`.
PR: open draft, merge immediately.

### S2 — Dedup / flood guard (P0)

A runaway agent hitting the same guardrail in a loop must not flood the inbox.
The schema already reserves `duplicate_count`; the insert path always sets it to
0. This slice adds the check.

**Kernel changes:**
- Add `context_hash VARCHAR` column to `inbox_messages` (SHA-256 of serialized
  `{kind, source, context}` so the lookup is an index scan).
- Add `find_recent_duplicate(kind, source, context_hash, window_secs) →
  Option<InboxMessage>` to `SqliteStore`.
- In `inbox_create_message` handler: look up a `pending` duplicate within the
  window (default 60 s). Found → `UPDATE inbox_messages SET duplicate_count =
  duplicate_count + 1 WHERE id = ?`; return the existing message with `200`. Not
  found → insert as today.

**Test:** one Rust integration test covering the dedup path + an increment-only
assertion for back-to-back posts within the window.

### S3 — Claude Code inbox hook (P1)

Makes Claude Code automatically write to the inbox — zero kernel change required.
Claude Code hooks run shell commands on lifecycle events; the hook calls
`gctrl inbox post` (or `curl /api/inbox/messages` if the shell is unavailable).

**Deliverables:**
- Hook registered in `.claude/settings.json`: `Stop` hook posts a
  `status_update` (urgency `info`) when a session ends.
- `PreToolUse` hook on guardrail-denied tool classes posts a `permission_request`
  (urgency `critical`, `requires_action: true`).
- Both hooks use `context_type: "session"`, `context_ref: "$CLAUDE_SESSION_ID"`.
- Documented in `apps/gctrl-inbox/vault/WORKFLOW.md` under a new "Claude Code
  Integration" section.

### S4 — InboxEvent on EventBus + SSE + live UI (P1)

The existing inbox UI polls `stats` every ~30 s. This slice makes it live.

**Kernel changes:**
- Add `InboxEvent` variants to `event_bus.rs` alongside `SessionEvent`:
  `MessageCreated { message_id, thread_id, urgency, kind }`,
  `ThreadUpdated { thread_id, pending_count, latest_urgency }`,
  `ActionRecorded { message_id, action_type }`.
- Publish the right variant after each successful `create_inbox_message`,
  `create_inbox_action`, and `batch_action` in `receiver.rs`.
- Add `GET /api/inbox/sse` SSE endpoint (mirrors the existing
  `/api/sessions/sse` pattern in `receiver.rs:795`). Streams `InboxEvent`
  frames. Supports `Last-Event-ID` replay from the ring.

**Client changes:**
- Replace the polling `setInterval` in `App.tsx` with an SSE connection to
  `/api/inbox/sse`. On `message_created` / `thread_updated`: bump the unread
  badge and refresh the `InboxPage` if it's active.

**Worker change:**
- Proxy `GET /api/inbox/sse` to the kernel (`proxyToKernel` already handles
  unknown paths when `KERNEL_URL` is set; confirm SSE streaming works through
  the Worker's `fetch` passthrough — may need `ReadableStream` forwarding).

### S5 — Bidirectional file mirror (P1)

Inbox messages live in SQLite (source of truth) but are **also** projected as
markdown files into a separate Obsidian-mountable vault root so the operator
can read and act on messages from Obsidian without opening the app.

**Layout:**
```
vault-gctrl-inbox/           # separate mount, sibling to vault-gctrl/
  BACK-42/                   # directory = context_ref (thread grouping)
    _thread.md               # rollup: pending_count, latest_urgency
    2026-05-28-permission-force-push.md
    2026-05-28-status-update.md
  session-abc123/
    2026-05-28-clarification.md
```

**Frontmatter schema (each message file):**
```yaml
---
id: <uuid>
thread: BACK-42
source: guardrail
kind: permission_request
urgency: high
status: pending
requires_action: true
created_at: 2026-05-28T14:03:00Z
content_hash: <sha256-of-this-file>   # echo-loop guard
decision:                              # human sets: approve | deny | acknowledge | defer
reason:                                # optional rationale
---
# <title>

<body markdown>

## Context
<context JSON rendered as key: value pairs>
```

**Kernel changes:**

1. Add `vault_path VARCHAR` + `content_hash VARCHAR` to `inbox_messages`
   schema (mirrors `board_issues` at `schema.rs:226`). Migration adds the
   columns with `ALTER TABLE … ADD COLUMN … DEFAULT NULL`.

2. Add `VaultMountKind::InboxMirror` variant. Watcher skips the board
   importer for this kind (`watch.rs:63` pattern) and instead dispatches to
   a new `inbox_importer`.

3. `project_inbox_message(msg, vault_root) → Result<()>` in
   `gctrl-storage`: renders deterministic markdown → `write_atomic` →
   stores the returned sha in `inbox_messages.content_hash` and
   `inbox_messages.vault_path`. Call this after every successful
   `create_inbox_message` (and after status changes that should be reflected:
   `duplicate_count` increments, action taken → update `status` in the file).

4. `inbox_importer`: called by the watcher on `Create/Modify` events under
   an `InboxMirror` mount. Reads `id` and `content_hash` from frontmatter.
   **Echo guard**: if `content_hash` matches `inbox_messages.content_hash`
   for that id → skip (own projection). If different → the human edited the
   file. Parse `decision` field:
   - `approve | deny | acknowledge | defer` → record `inbox_action`
     (first-writer-wins: if message is already non-`pending`, re-project the
     authoritative row back over the file and ignore).
   - No `decision` → ignore (treat as note-taking, not state change).

5. Add `POST /api/vault/mounts` body option `kind: "inbox_mirror"` so the
   desktop sidecar can register the new mount root on first launch (or
   `GCTRL_INBOX_VAULT_DIR` env var).

**No board importer changes** — the `INBOX/` board project in `vault-gctrl`
is unchanged; it tracks gctrl-inbox development tasks, not runtime messages.

### S6 — `/wait` long-poll + kernel auto-emit (P2)

See issue #74. Closes the reply loop so an agent that posts a `permission_request`
or `agent_question` can block on the human's decision without polling.

**Kernel changes:**
- `GET /api/inbox/messages/{id}/wait?timeout_secs=300` — SSE or long-poll that
  returns when the message transitions out of `pending` (action recorded or
  status changed). Uses the `InboxEvent` broadcast from S4.
- Guardrail engine (`gctrl-guardrails/src/engine.rs`): on deny, call
  `create_inbox_message` in-process with `kind: permission_request`, urgency
  based on policy level.
- Orchestrator session transitions to `Paused` → emit `SessionPaused` kernel
  event → inbox subscribes → creates `agent_question` / `permission_request`.

**Claude Code hook update (extends S3):**
- The `PreToolUse` hook for guardrail-denied actions upgrades from fire-and-forget
  to `gctrl inbox post … && gctrl inbox wait <id>`, blocking the hook until the
  human decides (within the hook's timeout). The agent resumes with the human's
  `reason` injected into context.
