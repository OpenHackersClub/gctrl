#!/usr/bin/env bats
# Tests for shell/hooks/claude-code-inbox.sh against a mock kernel.

HOOK="$BATS_TEST_DIRNAME/../claude-code-inbox.sh"
MOCK_PORT=14971

setup_file() {
  export CAPTURE_FILE="$BATS_FILE_TMPDIR/capture.jsonl"
  python3 "$BATS_TEST_DIRNAME/mock_kernel.py" "$MOCK_PORT" "$CAPTURE_FILE" &
  echo "$!" > "$BATS_FILE_TMPDIR/mock.pid"
  for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "http://127.0.0.1:$MOCK_PORT/" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "mock kernel did not start" >&2
  return 1
}

teardown_file() {
  kill "$(cat "$BATS_FILE_TMPDIR/mock.pid")" 2>/dev/null || true
}

setup() {
  : > "$CAPTURE_FILE"
  export GCTRL_KERNEL_PORT="$MOCK_PORT"
  export TERM_PROGRAM="iTerm.app"
  export TERM_PROGRAM_VERSION="3.5.0"
  export ITERM_SESSION_ID="w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765"
  unset GCTRL_INBOX_HOOK_DISABLE || true
}

last_capture() { tail -n 1 "$CAPTURE_FILE"; }

notification_event() { # $1 = notification_type
  jq -n --arg nt "$1" '{
    hook_event_name: "Notification",
    notification_type: $nt,
    message: "Claude needs your permission to use Bash",
    session_id: "sess-test-0001",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/project",
    permission_mode: "default"
  }'
}

@test "permission_prompt → permission_request, high urgency, requires_action, terminal identity" {
  run bash -c "echo '$(notification_event permission_prompt)' | '$HOOK'"
  [ "$status" -eq 0 ]
  body=$(last_capture)
  [ "$(jq -r .kind <<<"$body")" = "permission_request" ]
  [ "$(jq -r .urgency <<<"$body")" = "high" ]
  [ "$(jq -r .requires_action <<<"$body")" = "true" ]
  [ "$(jq -r .source <<<"$body")" = "agent" ]
  [ "$(jq -r .title <<<"$body")" = "Claude needs your permission to use Bash" ]
  [ "$(jq -r .context_type <<<"$body")" = "session" ]
  [ "$(jq -r .context_ref <<<"$body")" = "sess-test-0001" ]
  [ "$(jq -r .context.agent_name <<<"$body")" = "claude-code" ]
  [ "$(jq -r .context.terminal.app <<<"$body")" = "iterm2" ]
  [ "$(jq -r .context.terminal.session_id <<<"$body")" = "$ITERM_SESSION_ID" ]
  [ "$(jq -r .context.terminal.cwd <<<"$body")" = "/tmp/project" ]
  [ "$(jq -r .payload.notification_type <<<"$body")" = "permission_prompt" ]
  # permission prompts carry an expiry so stale ones auto-expire
  [ "$(jq -r .expires_at <<<"$body")" != "null" ]
}

@test "idle_prompt → agent_question, no action required, no expiry" {
  run bash -c "echo '$(notification_event idle_prompt)' | '$HOOK'"
  [ "$status" -eq 0 ]
  body=$(last_capture)
  [ "$(jq -r .kind <<<"$body")" = "agent_question" ]
  [ "$(jq -r .urgency <<<"$body")" = "medium" ]
  [ "$(jq -r .requires_action <<<"$body")" = "false" ]
  [ "$(jq -r '.expires_at // "absent"' <<<"$body")" = "absent" ]
}

@test "PreToolUse AskUserQuestion → agent_question with question text" {
  event=$(jq -n '{
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [
      { question: "Which database should we target?" },
      { question: "Apply migrations now?" }
    ]},
    session_id: "sess-test-0002",
    cwd: "/tmp/project"
  }')
  run bash -c "echo '$event' | '$HOOK'"
  [ "$status" -eq 0 ]
  body=$(last_capture)
  [ "$(jq -r .kind <<<"$body")" = "agent_question" ]
  [ "$(jq -r .requires_action <<<"$body")" = "true" ]
  [ "$(jq -r .title <<<"$body")" = "Which database should we target?" ]
  [[ "$(jq -r .body <<<"$body")" == *"Apply migrations now?"* ]]
}

@test "PreToolUse on other tools is ignored" {
  event=$(jq -n '{ hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "ls" }, session_id: "s", cwd: "/tmp" }')
  run bash -c "echo '$event' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ ! -s "$CAPTURE_FILE" ]
}

@test "non-request notification types are ignored" {
  run bash -c "echo '$(notification_event auth_success)' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ ! -s "$CAPTURE_FILE" ]
}

@test "kernel offline → exit 0 (fail-open)" {
  GCTRL_KERNEL_PORT=14999 run bash -c "echo '$(notification_event permission_prompt)' | GCTRL_KERNEL_PORT=14999 '$HOOK'"
  [ "$status" -eq 0 ]
  [ ! -s "$CAPTURE_FILE" ]
}

@test "GCTRL_INBOX_HOOK_DISABLE=1 → no-op" {
  run bash -c "echo '$(notification_event permission_prompt)' | GCTRL_INBOX_HOOK_DISABLE=1 '$HOOK'"
  [ "$status" -eq 0 ]
  [ ! -s "$CAPTURE_FILE" ]
}

@test "empty stdin → exit 0" {
  run bash -c "printf '' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ ! -s "$CAPTURE_FILE" ]
}

@test "TERM_PROGRAM → terminal.app mapping table" {
  # "TERM_PROGRAM=expected_app" pairs (bash 3.2 compatible — no declare -A)
  pairs="iTerm.app=iterm2 Apple_Terminal=terminal ghostty=ghostty vscode=vscode WarpTerminal=warp SomeGarbage=unknown"
  for pair in $pairs; do
    tp="${pair%%=*}"
    expected="${pair#*=}"
    : > "$CAPTURE_FILE"
    run bash -c "echo '$(notification_event permission_prompt)' | TERM_PROGRAM='$tp' '$HOOK'"
    [ "$status" -eq 0 ]
    actual=$(jq -r .context.terminal.app < "$CAPTURE_FILE")
    [ "$actual" = "$expected" ]
  done
  # unset TERM_PROGRAM → unknown
  : > "$CAPTURE_FILE"
  run bash -c "echo '$(notification_event permission_prompt)' | env -u TERM_PROGRAM '$HOOK'"
  [ "$status" -eq 0 ]
  [ "$(jq -r .context.terminal.app < "$CAPTURE_FILE")" = "unknown" ]
}
