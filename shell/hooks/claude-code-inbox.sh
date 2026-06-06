#!/bin/bash
# claude-code-inbox.sh — observe-only Claude Code → gctrl-inbox capture hook.
#
# Wired as a Claude Code `Notification` hook (permission_prompt, idle_prompt)
# and a `PreToolUse` hook matching `AskUserQuestion`. Reads the hook event
# JSON from stdin, snapshots terminal identity from the environment, and
# POSTs an inbox message to the kernel at /api/inbox/messages.
#
# Fire-and-forget by design: this script ALWAYS exits 0 and never blocks or
# influences Claude Code (no decision output). Kernel offline, missing jq,
# unknown events — all fail open with at most a stderr warning.
#
# Spec: vault/specs/architecture/apps/cc-permission-hook.md
#
# Env knobs:
#   GCTRL_KERNEL_PORT        kernel HTTP port (default 4318)
#   GCTRL_INBOX_HOOK_TTL     expires_at offset in seconds for permission
#                            prompts (default 3600; 0 disables expiry)
#   GCTRL_INBOX_HOOK_DISABLE set to 1 to no-op the hook entirely
#   GCTRL_PROJECT_KEY        override the derived project key

set -u

warn() { echo "[claude-code-inbox] $*" >&2; }

[ "${GCTRL_INBOX_HOOK_DISABLE:-0}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || { warn "jq not found; skipping"; exit 0; }
command -v curl >/dev/null 2>&1 || { warn "curl not found; skipping"; exit 0; }

INPUT=$(cat) || exit 0
[ -n "$INPUT" ] || exit 0

EVENT=$(jq -r '.hook_event_name // empty' <<<"$INPUT") || exit 0

# ── Map hook event → inbox message kind/urgency ──────────────────────────
KIND="" URGENCY="" REQUIRES_ACTION=false TITLE="" BODY="" WITH_EXPIRY=false
case "$EVENT" in
  Notification)
    NOTIFICATION_TYPE=$(jq -r '.notification_type // empty' <<<"$INPUT")
    MESSAGE=$(jq -r '.message // empty' <<<"$INPUT")
    case "$NOTIFICATION_TYPE" in
      permission_prompt)
        KIND="permission_request" URGENCY="high" REQUIRES_ACTION=true WITH_EXPIRY=true
        TITLE=${MESSAGE:-"Claude Code needs permission"}
        ;;
      idle_prompt)
        KIND="agent_question" URGENCY="medium" REQUIRES_ACTION=false
        TITLE=${MESSAGE:-"Claude Code is waiting for input"}
        ;;
      *) exit 0 ;; # other notification types are not requests-to-user
    esac
    ;;
  PreToolUse)
    TOOL_NAME=$(jq -r '.tool_name // empty' <<<"$INPUT")
    [ "$TOOL_NAME" = "AskUserQuestion" ] || exit 0
    KIND="agent_question" URGENCY="medium" REQUIRES_ACTION=true
    TITLE=$(jq -r '[.tool_input.questions[]?.question] | first // "Claude Code is asking a question"' <<<"$INPUT" | cut -c1-200)
    BODY=$(jq -r '[.tool_input.questions[]?.question] | join("\n\n")' <<<"$INPUT")
    ;;
  *) exit 0 ;;
esac

SESSION_ID=$(jq -r '.session_id // "unknown"' <<<"$INPUT")
CWD=$(jq -r '.cwd // empty' <<<"$INPUT")
TRANSCRIPT_PATH=$(jq -r '.transcript_path // empty' <<<"$INPUT")
PERMISSION_MODE=$(jq -r '.permission_mode // empty' <<<"$INPUT")

# ── Terminal identity snapshot (mac-comm context.terminal schema) ────────
case "${TERM_PROGRAM:-}" in
  iTerm.app)      TERM_APP="iterm2"   BUNDLE_ID="com.googlecode.iterm2" ;;
  Apple_Terminal) TERM_APP="terminal" BUNDLE_ID="com.apple.Terminal" ;;
  ghostty)        TERM_APP="ghostty"  BUNDLE_ID="com.mitchellh.ghostty" ;;
  vscode)         TERM_APP="vscode"   BUNDLE_ID="com.microsoft.VSCode" ;;
  WarpTerminal)   TERM_APP="warp"     BUNDLE_ID="dev.warp.Warp-Stable" ;;
  *)              TERM_APP="unknown"  BUNDLE_ID="local.unknown" ;;
esac

TERM_SESSION_ID=""
[ "$TERM_APP" = "iterm2" ] && TERM_SESSION_ID="${ITERM_SESSION_ID:-}"

# stdin is the hook pipe, so tty(1) reports "not a tty"; resolve via parent.
TTY=""
TTY_NAME=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
case "$TTY_NAME" in
  tty*|pty*) TTY="/dev/$TTY_NAME" ;;
esac

CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Project key: env override → git remote slug → repo dir → cwd basename ─
# Worktrees and clones with different dir names map to one project via the
# origin remote slug (e.g. checkouts "2acme" and "acme" both → "acme").
PROJECT_KEY="${GCTRL_PROJECT_KEY:-}"
if [ -z "$PROJECT_KEY" ] && [ -d "$CWD" ] && command -v git >/dev/null 2>&1; then
  REMOTE_URL=$(git -C "$CWD" remote get-url origin 2>/dev/null) || REMOTE_URL=""
  if [ -n "$REMOTE_URL" ]; then
    PROJECT_KEY=$(basename "$REMOTE_URL" .git)
  else
    TOPLEVEL=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""
    [ -n "$TOPLEVEL" ] && PROJECT_KEY=$(basename "$TOPLEVEL")
  fi
fi
[ -z "$PROJECT_KEY" ] && [ -n "$CWD" ] && PROJECT_KEY=$(basename "$CWD")
PROJECT_KEY=$(printf '%s' "$PROJECT_KEY" | tr -cd 'A-Za-z0-9._-' | cut -c1-64)

# ── Optional expiry: stale permission prompts auto-expire ────────────────
EXPIRES_AT=""
TTL="${GCTRL_INBOX_HOOK_TTL:-3600}"
if [ "$WITH_EXPIRY" = true ] && [ "$TTL" -gt 0 ] 2>/dev/null; then
  EXPIRES_AT=$(date -u -v "+${TTL}S" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "+${TTL} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || EXPIRES_AT=""
fi

# ── Build the inbox message (jq only — no string interpolation) ──────────
REQUEST_BODY=$(jq -n \
  --arg kind "$KIND" \
  --arg urgency "$URGENCY" \
  --argjson requires_action "$REQUIRES_ACTION" \
  --arg title "$TITLE" \
  --arg body "$BODY" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg transcript_path "$TRANSCRIPT_PATH" \
  --arg permission_mode "$PERMISSION_MODE" \
  --arg event "$EVENT" \
  --arg notification_type "${NOTIFICATION_TYPE:-}" \
  --arg term_app "$TERM_APP" \
  --arg bundle_id "$BUNDLE_ID" \
  --arg term_session_id "$TERM_SESSION_ID" \
  --arg tty "$TTY" \
  --arg pid "$$" \
  --arg ppid "$PPID" \
  --arg term_program "${TERM_PROGRAM:-}" \
  --arg term_program_version "${TERM_PROGRAM_VERSION:-}" \
  --arg captured_at "$CAPTURED_AT" \
  --arg expires_at "$EXPIRES_AT" \
  --arg project_key "$PROJECT_KEY" \
  '{
    source: "agent",
    kind: $kind,
    urgency: $urgency,
    requires_action: $requires_action,
    title: $title,
    context_type: "session",
    context_ref: $session_id,
    context: ({
      session_id: $session_id,
      agent_name: "claude-code",
      terminal: ({
        app: $term_app,
        bundle_id: $bundle_id,
        session_id: $term_session_id,
        tty: $tty,
        pid: ($pid | tonumber),
        ppid: ($ppid | tonumber),
        cwd: $cwd,
        term_program: $term_program,
        term_program_version: $term_program_version,
        captured_at: $captured_at
      } | with_entries(select(.value != "")))
    } + (if $project_key != "" then { project_key: $project_key } else {} end)),
    payload: ({
      hook_event: $event,
      notification_type: $notification_type,
      transcript_path: $transcript_path,
      permission_mode: $permission_mode,
      cwd: $cwd
    } | with_entries(select(.value != "")))
  }
  + (if $body != "" then { body: $body } else {} end)
  + (if $expires_at != "" then { expires_at: $expires_at } else {} end)
  + (if $project_key != "" then { project_key: $project_key } else {} end)') || exit 0

PORT="${GCTRL_KERNEL_PORT:-4318}"
curl -fsS --connect-timeout 1 --max-time 3 \
  -X POST -H 'Content-Type: application/json' \
  -d "$REQUEST_BODY" \
  "http://127.0.0.1:${PORT}/api/inbox/messages" >/dev/null 2>&1 \
  || warn "kernel unreachable on :${PORT}; message dropped (fail-open)"

exit 0
