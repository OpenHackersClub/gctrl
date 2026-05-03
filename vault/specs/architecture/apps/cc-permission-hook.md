# Claude Code Permission Hook

> Bash hook installed in `~/.claude/settings.json` that captures the running terminal's identity, posts a `permission_request` message to gctrl-inbox, and blocks Claude Code until the user acts.

> **Status**: companion spec to [`mac-comm.md`](../kernel/mac-comm.md). The kernel-side primitive (driver, deeplink, UI) ships with mac-comm PR-1..3; the hook itself ships as its own follow-up PR.

---

## Why a separate spec

Different agent frameworks (Claude Code, Cursor, Aider, Codex) need different capture mechanisms:

- **Claude Code** has a structured `PreToolUse` hook protocol with stdin JSON.
- **Cursor** has its own per-tool callback model.
- **Aider** runs as a Python process with hookable `before_run` events.

Each framework owns its own integration spec; all of them post the same `context.terminal` shape into `/api/inbox/messages`, defined in [mac-comm.md § Schema](../kernel/mac-comm.md#schema-inbox_messagescontextterminal-not-payload).

---

## Hook contract

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "$HOME/.local/share/gctrl/hooks/claude-code-permission.sh"
      }]
    }]
  }
}
```

`claude-code-permission.sh` behavior:

1. Read tool-use JSON from stdin.
2. Detect terminal: read `$TERM_PROGRAM` and map → `terminal.app` discriminator.
   - `iTerm.app` → `iterm2`
   - `Apple_Terminal` → `terminal`
   - `ghostty` → `ghostty`
   - `vscode` → `vscode`
   - `WarpTerminal` → `warp`
   - empty / anything else → `unknown` (no Focus button rendered downstream)
3. Snapshot identity:
   - `session_id`: `$ITERM_SESSION_ID` (iTerm2) or platform-specific else `unknown`
   - `tty`: `$(tty)`
   - `pid`: `$$`, `ppid`: `$PPID`
   - `cwd`: `$PWD`
   - `term_program`, `term_program_version`: passthrough
4. POST to `http://127.0.0.1:4318/api/inbox/messages` with `kind=permission_request`, `context.terminal={…}`, `payload={ command, args }`.
5. Poll `GET /api/inbox/messages/{id}` every **1 s** until `status != pending` or timeout.
6. Default timeout: **30 s**, configurable via `GCTRL_COMM_TIMEOUT` env (clamped to `[5, 600]`).
7. Exit `0` (allow) on `acted+approve`, `2` (deny+block) on `acted+deny` or timeout, `1` on hard error.

---

## Edge cases

| Condition | Behavior |
|---|---|
| Kernel daemon offline (`curl: Failed to connect`) | Exit `0` (allow) with stderr warning — fail-open since kernel-mediated approval is opt-in dogfooding, not a hard guardrail. |
| `TERM_PROGRAM` unset | `terminal.app = unknown`, no Focus button downstream, but message still posts. |
| Timeout reached before user acts | Exit `2` (deny+block), tell Claude Code "user did not respond in N seconds". |
| Network hiccup mid-poll | Retry up to 3 times with 1 s backoff before exiting `1`. |

---

## Tests

- **`shellcheck` clean** in CI (script must lint without suppressions).
- **`bats` test cases** with a mock HTTP server (`python3 -m http.server` or a small `nc` script):
  - approve → exit `0`
  - deny → exit `2`
  - timeout (mock returns `pending` forever) → exit `2`
  - kernel offline → exit `0` with warning
  - retry exhaustion → exit `1`
- **Table-driven `TERM_PROGRAM` → `terminal.app` mapping test** in `bats`: covers `iTerm.app`, `Apple_Terminal`, `ghostty`, `code`, `WarpTerminal`, empty, garbage value.

---

## Implementation strategy

Single PR, lands after `mac-comm.md` PR-1 (the kernel intake validator must be ready to accept `context.terminal`):

- New file `shell/hooks/claude-code-permission.sh` (≤ 80 lines).
- Bundling: `gctrl-desktop` first-run copies it into `~/.local/share/gctrl/hooks/`. Non-desktop users install via `make install-hooks` or by symlinking from the repo.
- Docs: snippet in `apps/gctrl-inbox/WORKFLOW.md` showing the `~/.claude/settings.json` wiring and the `GCTRL_COMM_TIMEOUT` knob.

---

## Related Docs

- [`vault/specs/architecture/kernel/mac-comm.md`](../kernel/mac-comm.md) — driver primitive this hook is the first consumer of
- [`apps/gctrl-inbox/PRD.md`](../../../../apps/gctrl-inbox/PRD.md) — message model
- [`apps/gctrl-inbox/WORKFLOW.md`](../../../../apps/gctrl-inbox/WORKFLOW.md) — where the user-facing wiring snippet lands
