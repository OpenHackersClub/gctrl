# Claude Code → Inbox Capture Hooks

> Hooks installed in `~/.claude/settings.json` that capture Claude Code's requests-to-user (permission prompts, questions, idle waits) and post them to gctrl-inbox as messages, with the running terminal's identity attached for click-to-focus.

> **Status**: companion spec to [`mac-comm.md`](../kernel/mac-comm.md). Slice sequencing lives in [`apps/gctrl-inbox/vault/ROADMAP.md`](../../../../apps/gctrl-inbox/vault/ROADMAP.md), not here.

---

## Why a separate spec

Different agent frameworks (Claude Code, Cursor, Aider, Codex) need different capture mechanisms:

- **Claude Code** has a structured hook protocol with stdin JSON (`Notification`, `PreToolUse`, `PostToolUse`, …).
- **Cursor** has its own per-tool callback model.
- **Aider** runs as a Python process with hookable `before_run` events.

Each framework owns its own integration spec; all of them post the same `context.terminal` shape into `/api/inbox/messages`, defined in [mac-comm.md § Schema](../kernel/mac-comm.md#schema-inbox_messagescontextterminal-not-payload).

---

## Decision: hooks, not log polling

Two capture architectures were considered for "Claude Code requests-to-user land in the inbox":

| | Hooks (push) | Poll transcript JSONL (pull) |
|---|---|---|
| Signal fidelity | Exact event — Claude Code reports "I need the user" | Inferred: a `tool_use` with no result could be a permission wait *or* a slow tool |
| Terminal identity (`context.terminal`) | Hook runs inside the agent process — `$ITERM_SESSION_ID`, `$TERM_PROGRAM`, tty, pid all capturable | Not in the logs. Polling kills the mac-comm Focus deeplink |
| Latency | Immediate | Poll interval + parse lag |
| Format stability | Documented hook stdin contract | `~/.claude/projects/*/*.jsonl` is an undocumented internal format |

**Hooks win** — mac-comm.md already records the load-bearing constraint: *the kernel cannot read the agent's environment, so capture must happen agent-side.* Transcript reading is permitted only as **enrichment**: the hook payload carries `transcript_path`, and the kernel MAY do a one-shot read at message-creation time to enrich the inbox card. Never a continuous watcher; if the parse breaks on a Claude Code upgrade, enrichment is lost, not the message.

---

## Two capture modes

| Mode | Mechanism | Blocking? | What the user gets |
|---|---|---|---|
| **Observe** | `Notification` hook (`permission_prompt`, `idle_prompt`) + `PreToolUse` hook on `AskUserQuestion`, fire-and-forget | No — always exits `0`, no decision output | Requests appear in the inbox in real time with a Focus deeplink; the user answers in the terminal |
| **Act** | `PreToolUse` hook on gated tools that polls the inbox message until acted | Yes — exit code carries approve/deny | The user approves/denies *from* the inbox; Claude Code resumes/blocks accordingly |

Observe mode honors inbox Principle 3 (agents MUST NOT block on the inbox) with no carve-out. Act mode requires the async-by-design carve-out documented in [mac-comm.md](../kernel/mac-comm.md#async-by-design-carve-out). Both modes share the same script skeleton and `context.terminal` capture.

---

## Observe mode

### Script: `shell/hooks/claude-code-inbox.sh`

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "$HOME/.local/share/gctrl/hooks/claude-code-inbox.sh", "timeout": 10 }]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "$HOME/.local/share/gctrl/hooks/claude-code-inbox.sh", "timeout": 10 }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "$HOME/.local/share/gctrl/hooks/claude-code-inbox.sh", "timeout": 10 }]
      }
    ]
  }
}
```

### Event → message mapping

| Hook event | Inbox kind | Urgency | `requires_action` | Expiry |
|---|---|---|---|---|
| `Notification` / `permission_prompt` | `permission_request` | `high` | `true` | `now + GCTRL_INBOX_HOOK_TTL` (default 3600 s) — stale prompts auto-expire since the user may have answered in the terminal |
| `Notification` / `idle_prompt` | `agent_question` | `medium` | `false` | none |
| `PreToolUse` / `AskUserQuestion` | `agent_question` (title = first question, body = all questions) | `medium` | `true` | none |
| Any other event / notification type | ignored (exit `0`, no POST) | — | — | — |

All messages POST with `source=agent`, `context.agent_name=claude-code`, `context_type=session`, `context_ref=<claude session_id>` — so messages from one Claude Code session group into one inbox thread. `payload` carries `hook_event`, `notification_type`, `transcript_path`, `permission_mode`, `cwd`.

Messages also carry a **`project_key`** (top-level for thread stamping + `context.project_key`) so the inbox can group/filter by project. Derivation, in priority order:

1. `GCTRL_PROJECT_KEY` env override
2. origin remote slug (`git -C "$cwd" remote get-url origin`, basename minus `.git`) — worktrees and renamed checkouts of the same repo map to one project
3. git toplevel basename (local repo without a remote)
4. cwd basename (outside git)

The key is sanitized to `[A-Za-z0-9._-]{1,64}`.

### Behavior

1. Read hook-event JSON from stdin (`session_id`, `transcript_path`, `cwd`, `permission_mode`, plus event-specific fields).
2. Detect terminal: read `$TERM_PROGRAM` and map → `terminal.app` discriminator.
   - `iTerm.app` → `iterm2`
   - `Apple_Terminal` → `terminal`
   - `ghostty` → `ghostty`
   - `vscode` → `vscode`
   - `WarpTerminal` → `warp`
   - empty / anything else → `unknown` (no Focus button rendered downstream)
3. Snapshot identity per [mac-comm.md § Schema](../kernel/mac-comm.md#schema-inbox_messagescontextterminal-not-payload):
   - `session_id`: `$ITERM_SESSION_ID` (iTerm2 only)
   - `tty`: resolved via the parent process (`ps -o tty= -p $PPID`) — the hook's own stdin is the event pipe, not a tty
   - `pid`: `$$`, `ppid`: `$PPID`
   - `cwd`: from the hook payload
   - `term_program`, `term_program_version`: env passthrough
   - empty fields are omitted, never sent as `""`
4. POST to `http://127.0.0.1:4318/api/inbox/messages` (port via `GCTRL_KERNEL_PORT`). JSON is built exclusively with `jq -n --arg` — no string interpolation.
5. **Always exit `0`.** No stdout. The hook can never block, slow (curl budget: 1 s connect / 3 s total), or influence Claude Code.

### Edge cases

| Condition | Behavior |
|---|---|
| Kernel daemon offline | Exit `0` with stderr warning — fail-open; the message is dropped. |
| `jq` or `curl` missing | Exit `0` with stderr warning. |
| `TERM_PROGRAM` unset | `terminal.app = unknown`, no Focus button downstream, message still posts. |
| Empty / malformed stdin | Exit `0`, no POST. |
| `GCTRL_INBOX_HOOK_DISABLE=1` | Exit `0` immediately, no POST (kill switch). |

### Known limitation — staleness

Observe mode is one-way: when the user answers the prompt in the terminal, the inbox message stays `pending` until acted on, acknowledged, or expired. The `expires_at` TTL on permission prompts bounds the staleness window. Closing the loop (terminal answer → inbox message resolved) is act mode's job.

---

## Act mode (blocking permission hook)

> Design retained; not yet implemented. See the ROADMAP row before building.

A `PreToolUse` hook matching gated tools (`Bash|Edit|Write`) that:

1. POSTs `kind=permission_request` with the same `context.terminal` shape.
2. Polls `GET /api/inbox/messages/{id}` every **1 s** until `status != pending` or timeout.
3. Default timeout: **30 s**, configurable via `GCTRL_COMM_TIMEOUT` env (clamped to `[5, 600]`).
4. Exit `0` (allow) on `acted+approve`, `2` (deny+block) on `acted+deny` or timeout, `1` on hard error.
5. Kernel offline → exit `0` (allow) with stderr warning — fail-open since kernel-mediated approval is opt-in dogfooding, not a hard guardrail.

Act mode supersedes observe mode's `permission_prompt` capture for the matched tools (the hook decision *is* the request); the `Notification` capture remains for everything act mode doesn't gate.

---

## Tests

- **`shellcheck` clean** in CI (no suppressions) — `hooks` job in `.github/workflows/ci.yml`.
- **`bats` suite** (`shell/hooks/test/`) against a mock kernel (`mock_kernel.py`):
  - `permission_prompt` → `permission_request`, high urgency, terminal identity, expiry set
  - `idle_prompt` → `agent_question`, no action required
  - `PreToolUse AskUserQuestion` → `agent_question` with question text
  - other tools / other notification types → ignored
  - kernel offline → exit `0`, fail-open
  - kill switch → no POST
  - table-driven `TERM_PROGRAM` → `terminal.app` mapping (incl. empty and garbage values)

---

## Installation

- Bundling: `gctrl-desktop` first-run copies `shell/hooks/*.sh` into `~/.local/share/gctrl/hooks/`.
- Non-desktop users: copy or symlink from the repo — wiring snippet lives in [`apps/gctrl-inbox/vault/WORKFLOW.md`](../../../../apps/gctrl-inbox/vault/WORKFLOW.md#claude-code-capture-hook-observe).

---

## Related Docs

- [`vault/specs/architecture/kernel/mac-comm.md`](../kernel/mac-comm.md) — driver primitive these hooks feed (`context.terminal` → Focus deeplink)
- [`apps/gctrl-inbox/vault/PRD.md`](../../../../apps/gctrl-inbox/vault/PRD.md) — message model
- [`apps/gctrl-inbox/vault/ROADMAP.md`](../../../../apps/gctrl-inbox/vault/ROADMAP.md) — slice sequencing + issue links
- [`apps/gctrl-inbox/vault/WORKFLOW.md`](../../../../apps/gctrl-inbox/vault/WORKFLOW.md) — user-facing wiring snippet
