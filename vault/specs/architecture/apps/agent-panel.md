# Agent Panel

> A kanban board of every coding-agent conversation on the machine: Claude Code, Codex, Hermes Agent and Pi. Columns show state, swimlanes group runs by project, and a click focuses the live terminal pane or resumes the conversation in iTerm2. Selected runs can be gathered into one iTerm2 window on a chosen macOS Space. The board rebuilds from the harnesses' own stores, so it survives an app restart and a reboot.

**Status**: in progress. Slices: [ROADMAP § Agent Panel](../../gctrl/ROADMAP.md#agent-panel--in-progress).
**Scope**: kernel driver `gctrl-driver-agents`, mac-comm `launch`, `open_window`, `focus_tty` and `close_tty`, driver-macos `switch_to`, the gctrl-board `/agents` page.
**Related**: [adr-session-is-the-spine.md](adr-session-is-the-spine.md), [cc-permission-hook.md](cc-permission-hook.md), [mac-comm.md](../kernel/mac-comm.md), [driver-macos.md § Switching Spaces](../kernel/driver-macos.md#switching-spaces).

## Terms

1. **Harness**: the agent CLI that owns a conversation. Values: `claude-code`, `codex`, `hermes`, `pi`.
2. **Adapter**: the driver module that reads one harness's store and attributes its processes. Each adapter returns run records; the index turns records into runs.
3. **Run**: one conversation in one harness, identified by `<harness-prefix>:<native id>` (`claude:…`, `codex:…`, `hermes:…`, `pi:…`).
4. **Live**: a harness process for the run exists. See § Liveness.
5. **Headless**: a run with no interactive terminal: Codex `source = exec`, a Claude transcript whose `entrypoint` is `sdk-cli`, or a Hermes session whose `source` is neither `cli` nor `tui` (gateway sessions such as Telegram and cron).
6. **Stale**: a run that is not live and has no activity for 7 days or more.
7. **Gather**: resuming a set of runs as tabs of one new iTerm2 window on one Space.

## Sources

The driver reads harness stores and never writes them.

| Harness | Store | Fields |
| --- | --- | --- |
| Claude Code | `<config>/projects/<cwd-slug>/<uuid>.jsonl` (top level only; subagent transcripts are excluded) | `cwd`, `gitBranch`, `timestamp`, `entrypoint`, `custom-title.customTitle`, `agent-name.agentName`, `last-prompt.lastPrompt`, `pr-link.{prNumber,prUrl,prRepository}`, `cost-state.totalCostUSD` |
| Claude Code | Session-map records in the same transcript: `assistant` → `tool_use` named `*session-map__update` (input `goal`, `status`, `summary`, `steps`), its `tool_result` (the printed map: `Session <name> […]`, `Goal:`, `Status: <status> — <summary>`, `Steps:` lines `- [x]`, `- [>]`, `- [ ]`), and `attachment` of type `goal_status` (`/goal` `condition`) | goal, session name, status, summary, steps |
| Claude Code | `<config>/sessions/<pid>.json` (live registry) | `pid`, `sessionId`, `cwd`, `status` (`busy`, `idle`, `shell`), `procStart`, `kind` |
| Codex | `$CODEX_HOME/state_<n>.sqlite` → `threads` (highest `<n>` wins; default `~/.codex`) | `id`, `cwd`, `name`, `title`, `first_user_message`, `git_branch`, `git_origin_url`, `tokens_used`, `model`, `archived`, `source`, `thread_source`, `created_at_ms`, `updated_at_ms`, `rollout_path` |
| Codex | Tail of the thread's rollout JSONL | Last `response_item` message with `role = user`; last `event_msg` of type `task_started`, `task_complete` or `turn_aborted` |
| Hermes Agent | `$HERMES_HOME/state.db` → `sessions`, `messages` (default `~/.hermes`) | `sessions.{id, source, cwd, title, model, started_at, ended_at, end_reason, parent_session_id, archived, input_tokens, output_tokens, actual_cost_usd, estimated_cost_usd}`; per session the first and last `user` message, and the role and `tool_calls` of the newest message |
| Pi | `<sessions>/--<cwd>--/<timestamp>_<id>.jsonl`, where `<sessions>` is `$PI_CODING_AGENT_SESSION_DIR`, else `$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions` | Header `session.{id, cwd, timestamp}`; `session_info.name`; `model_change.modelId`; `message.message.{role, content, model, stopReason}` |
| All | `ps -axo pid=,lstart=,tty=,command=` with `LC_ALL=C TZ=UTC`, and `lsof -a -d cwd` | pid liveness, process start time, tty, argv and cwd |

Rules:

1. `<config>` is every Claude Code config dir: `~/.claude`, `~/.claude/clients/*`, `~/.claude-*` and `~/.config/claude/*`. These are the places a per-project `CLAUDE_CONFIG_DIR` (set by direnv) points. Each config dir keeps its own live registry. Their `projects/` dirs are often symlinks to one store, so the driver scans each real path once.
2. The driver never opens `<config>/sessions/*.key`. Those files hold socket credentials.
3. Codex rows with `thread_source` other than `user` (guardian reviews, subagents) are excluded.
4. The driver parses JSONL transcripts (Claude, Pi) incrementally from the last byte offset. A file read for the first time is parsed whole when it is at most 576 KiB, else as its first 64 KiB and last 512 KiB. A file that shrinks is parsed again from the start.
5. SQLite stores (Codex, Hermes) open with `mode=ro`. When the harness is not running, the WAL index is absent and a read-only connection cannot create it. The driver then opens the database with `immutable=1`, which is safe because with no `-wal` file the main database file holds every committed write. Queries read `PRAGMA table_info` first and treat missing columns as `NULL`.
6. Hermes context compression ends a session with `end_reason = 'compression'` and continues in a child session. A chain MUST retain the oldest session's run identity, `started_at` and first prompt; `native_id` MUST identify the newest session for resuming. Hermes rows with active-message tracking (`messages.active`) count only active messages.
7. A session-map tool result follows its call and prints the whole map, so it overrides the call's input. Only transcript lines that name `session-map__update`, `goal_status`, or a printed `Goal:` / `Status:` line are parsed in full.
8. A prompt shown on a card excludes harness-injected text: lines that start with `<`, the AGENTS.md preamble, and messages relayed from another agent session.

## Liveness

1. **Claude Code**: a registry entry MUST have a live pid whose normalized process start time equals its `procStart`. An entry without `procStart` MUST identify a `claude` CLI process instead.
2. **Codex, Hermes, Pi**: the driver attributes harness processes to runs.
   1. A harness process is one whose executable is the harness name (`codex`, `hermes`, `pi`), or an interpreter (`node`, `bun`, `deno`, `python`, `python3`, `python3.N`) whose first argument is a script with that name. Codex processes inside an `.app` bundle are excluded.
   2. One process per tty counts: the lowest pid, which is the parent of any helper it spawned.
   3. A process whose argv contains a run id belongs to that run. For Hermes, an id earlier in a compression chain belongs to the chain's run.
   4. Otherwise the process belongs to the most recently updated unclaimed interactive run whose cwd equals the process cwd (`lsof`).

## Model

The index lives in kernel memory. It is rebuilt from the adapters at kernel start and refreshed when `GET /api/agents` is called more than 2 s after the last refresh. Mirroring runs into the `sessions` table is tracked in #240.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `<harness-prefix>:<conversation id>`; Hermes uses the compression chain's root id, other harnesses use `native_id` |
| `harness` | `claude-code` \| `codex` \| `hermes` \| `pi` | Owning harness |
| `native_id` | string | The harness's own session or thread id |
| `title` | string | Claude custom title; Codex thread name or title; Hermes session title; Pi session name; else the first prompt (cut to 120 chars) |
| `name` | string \| null | Claude `agent-name` (the `/rename` name), else the session-map name; Codex thread name; Hermes title; Pi session name |
| `project_key` | string | See § Project key |
| `cwd` | string | Working directory of the run. A Hermes session with no recorded cwd uses the home directory. |
| `cwd_exists` | boolean | Whether `cwd` exists now |
| `worktree` | string \| null | The cwd's directory name when the cwd is a linked git worktree |
| `git_branch` | string \| null | Branch at the last record (Claude, Codex) |
| `goal` | string \| null | The outcome the run works toward, cut to 160 chars. Claude: the session-map goal (which already reflects `/goal`), else the `/goal` condition. Codex: the generated thread name, unless `/rename` replaced it with an `s-` handle or it equals the title. |
| `progress` | `{status, summary, current_step, steps_done, steps_total}` \| null | Claude session map: `status` (`active`, `blocked`, `handoff`, `done`), the one-line summary, the step in progress (else the first pending step), and step counts. Null when the session never reported a map. |
| `last_prompt` | string \| null | Last user prompt, cut to 200 chars |
| `pr` | `{number, url, repository}` \| null | Last `pr-link` record (Claude) |
| `cost_usd` | number \| null | Claude `cost-state.totalCostUSD`; Hermes actual, else estimated, cost |
| `tokens` | number \| null | Codex `tokens_used`; Hermes input plus output tokens |
| `model` | string \| null | Codex, Hermes or Pi model |
| `started_at`, `updated_at` | RFC 3339 | First and last activity |
| `headless`, `archived`, `stale` | boolean | See § Terms. `archived` is Codex or Hermes `archived = 1`. |
| `live` | `{pid, tty, status}` \| null | `status` is `busy`, `idle` or `unknown` (Claude `shell`) |
| `state` | `running` \| `idle` \| `resumable` \| `done` | See § States |
| `resume_command` | string \| null | Display copy of the launch command; null when `cwd_exists` is false |

## Project key

1. When the cwd exists, the key is the basename of `git remote get-url origin` without `.git`. Otherwise it is the basename of `git rev-parse --show-toplevel`. Otherwise it is the cwd basename. This is the rule in `shell/hooks/claude-code-inbox.sh`.
2. A Codex thread with `git_origin_url` uses that URL directly.
3. A cwd under `~/wt/<path>/<name>` resolves through `~/workspaces/<path>`, whether or not it still exists, and `<name>` is its worktree. When the cwd is gone, A cwd under `<repo>/.claude/worktrees/<name>` resolves through `<repo>`. Any other cwd resolves through its nearest existing ancestor.
4. The key keeps only `[A-Za-z0-9._-]` and is cut to 64 characters.
5. A cwd under `~/Documents`, `~/Desktop`, `~/Downloads` or `~/Library/Mobile Documents`, or on a volume other than the home directory's, is keyed by its directory name, with no git call. macOS guards those locations with a privacy prompt; a read inside them from the kernel raises the prompt and blocks until it is answered.
6. A git call that takes longer than 3 s is abandoned and counts as no repository, so rule 1 falls back to the cwd basename.

## States

| State | Column | Condition |
| --- | --- | --- |
| `running` | Running | Live, and `live.status = busy` |
| `idle` | Idle | Live, and not running |
| `resumable` | Resumable | Not live |
| `done` | Done | `archived` |

`live.status` is `busy` while a turn is open:

| Harness | Busy when |
| --- | --- |
| Claude Code | Registry `status = busy` |
| Codex | The rollout's last turn event is `task_started`; with no turn event in the tail, the rollout changed in the last 10 s |
| Hermes Agent | The newest message has role `user` or `tool`, or role `assistant` with tool calls |
| Pi | The newest message has role `user` or `toolResult`, or role `assistant` with `stopReason = toolUse` |

The **Needs you** column is computed by the board. A live run is in Needs you when an open inbox message with `requires_action = true` has `context.session_id` equal to the run's `native_id`, or when its `progress.status` is `blocked` or `handoff`. The kernel driver makes no assumptions about apps.

## HTTP API

`GET /api/agents?include_headless=false&include_stale=false`

```json
{
  "generated_at": "2026-11-28T09:00:00Z",
  "runs": [ { "id": "claude:26e3…", "harness": "claude-code", "state": "idle", "…": "…" } ],
  "hidden": { "headless": 12, "stale": 340 },
  "gather_queue": ["codex:01a0…"]
}
```

`POST /api/agents/{id}/open?dry_run=false`

| Case | Status | Body |
| --- | --- | --- |
| Live, and the pane is found by tty in iTerm2 or Terminal.app | 200 | `{"action":"focused","detail":"iTerm2"}` |
| Live, and no pane matches the tty | 200 | `{"action":"none","detail":"terminal_not_found"}` |
| Not live | 200 | `{"action":"launched","command":"cd '…' && claude --resume …"}` |
| `dry_run=true` | 200 | The same body with no AppleScript run, and `action` prefixed `would_` |
| Unknown id | 404 | `unknown run` |
| Not live and `cwd_exists = false` | 409 | `cwd_missing` |
| Automation denied | 403 | From mac-comm |

`POST /api/agents/gather` with `{"ids": ["claude:…", "codex:…"], "close_old": true}`

```json
{
  "window_id": 4012,
  "items": [
    { "id": "claude:26e3…", "action": "moved", "detail": "closed old iTerm2 pane" },
    { "id": "codex:01a0…", "action": "queued", "detail": "waits for its turn to end" },
    { "id": "pi:019a…", "action": "skipped", "detail": "cwd_missing" }
  ]
}
```

| `action` | Meaning |
| --- | --- |
| `resumed` | Not live; resumed in the gather window |
| `moved` | Was idle; stopped, then resumed in the gather window |
| `queued` | Mid-turn or status unknown; moves when its turn ends |
| `stopped` | Stopped, but the resume failed; the run is Resumable on the board |
| `skipped` | `unknown_run`, `already_queued`, `cwd_missing`, `no_tty` or `did_not_exit` |

A body with no ids returns 400. When opening the window fails, the call returns the mac-comm error status (403 when Automation is denied) and no run is stopped.

`DELETE /api/agents/{id}/gather` removes a run from the gather queue (204).

## Open and resume

```mermaid
sequenceDiagram
  autonumber
  actor U as Operator
  box rgba(37,99,235,0.15) gctrl
    participant P as Agents page
    participant K as driver-agents
    participant M as mac-comm
  end
  box rgba(156,163,175,0.15) macOS
    participant I as iTerm2
  end
  U->>P: click card
  P->>K: POST /api/agents/{id}/open
  K->>K: refresh liveness (ps)
  alt live
    K->>M: focus_tty(tty)
    M->>I: select the session whose tty matches
  else not live
    K->>K: validate id and cwd
    K->>M: launch(command)
    M->>I: new tab, write text command
  end
  K-->>P: action
```

1. The launch command MUST invoke the fixed resume argv for its harness after changing directory and activating the environment (see `kernel/crates/gctrl-mac-comm/src/launch.rs::shell_command`):

   | Harness | Resume argv |
   | --- | --- |
   | Claude Code | `claude --resume <id>` |
   | Codex | `codex resume -c tui.resume_cwd=current <id>` |
   | Hermes Agent | `hermes --resume <id>` |
   | Pi | `pi --session <id>` |

2. Every argv token, `<id>` included, matches `^[A-Za-z0-9._=:/@+-]{1,128}$`. `<cwd>` passes the mac-comm `cwd` validator, which excludes `'`, so single quotes are safe.
3. AppleScript receives the command as an `argv` item and never concatenates it into script text.
4. `write text` MUST type into the tab's interactive login shell so user shell functions and aliases apply. After `cd`, the command MUST apply `direnv export bash` when direnv is available, before invoking the harness. Failed environment activation MUST prevent launch. This applies the project's `CLAUDE_CONFIG_DIR` before a Bash prompt hook runs.
5. Claude keys transcripts by cwd slug and cannot resume from another directory. When `cwd_exists` is false, the board disables Resume.
6. Open re-probes liveness before it acts, and debounces launches of one run for 5 s. A run that is open in any terminal is focused, never launched a second time.

## Gather into a Space

The operator selects runs on the board, picks a Space, and confirms. The board switches to the Space, then calls the gather route. A new window opens on the active Space, so the window lands on the chosen Space.

```mermaid
sequenceDiagram
  autonumber
  actor U as Operator
  box rgba(37,99,235,0.15) gctrl
    participant P as Agents page
    participant D as driver-macos
    participant K as driver-agents
    participant M as mac-comm
  end
  box rgba(156,163,175,0.15) macOS
    participant I as iTerm2
  end
  U->>P: select runs, pick Space, Gather
  P->>D: POST /api/macos/spaces/{id}/switch
  D-->>P: 204 once the Space is active
  P->>K: POST /api/agents/gather
  K->>K: refresh liveness (ps)
  K->>M: open_window(first resumable run)
  M->>I: create window, write text
  loop each idle run
    K->>K: SIGTERM, wait up to 5 s for exit
    K->>M: open_tab_in_window(window, command)
    opt close_old and only a shell is left on the old tty
      K->>M: close_tty(old tty)
    end
  end
  K-->>P: items (busy runs queued)
  rect rgba(217,119,6,0.15)
    loop every 3 s, up to 4 h, per queued run
      K->>K: refresh; when idle, SIGTERM and wait
      K->>M: open_tab_in_window(window, command)
    end
  end
```

1. The board omits the switch when the chosen Space is the current one. A switch failure aborts the gather: 403 means gctrld lacks Accessibility, 501 means the Mission Control shortcuts are off.
2. Runs are planned from a fresh refresh:
   1. Not live, cwd present: resume.
   2. Live with `status = idle`: stop, then resume.
   3. Live with `status = busy` or `unknown`: queue.
   4. Live with no tty, cwd gone, an open or gather operation in progress, a launch within the 5 s debounce, or unknown id: skip.
3. The window opens before any process is stopped. It opens with the first directly resumable run's command; when there is none, the first run moved into it, stopped or queued, reuses the window's initial shell.
4. Stopping sends SIGTERM to the run's pid after checking the pid is still on the run's tty, then waits up to 5 s for it to exit. A run that does not exit is skipped (`did_not_exit`). Every harness writes each message as it completes, so an idle run's conversation is on disk.
5. With `close_old`, the pane a stopped run leaves behind is closed only when every process on its tty is a shell or `login`.
6. A queued run is checked every 3 s. When its turn ends it is stopped and resumed in the gather window. When that window is gone, it resumes in a new window. It leaves the queue when moved, when it disappears, when `DELETE /api/agents/{id}/gather` cancels it, or after 4 h.
7. At most 32 runs move per gather.
8. Open and gather MUST atomically claim each run before terminal side effects. One claim MUST own both immediate and queued work until completion or failure. Cancelling queued work MUST prevent another owner until the cancelled worker exits. Disconnecting an HTTP caller MUST retain ownership until its terminal operation finishes.

## Adding a harness

1. Add a `Harness` variant with its run-id prefix and resume argv (`model.rs`).
2. Add an adapter that implements `Adapter::scan` and returns one `RunRecord` per run (`adapter.rs` is the contract). An adapter without a live registry attributes processes with `adapter::match_processes`.
3. Register the adapter in `Paths::adapters` with its store path and environment override.
4. Add the harness mark to the board card.

## Board page

1. Route `/agents` in the gctrl-board SPA, with a nav entry. gctrl-desktop renders the page.
2. Columns: Needs you, Running, Idle, Resumable, Done (collapsed). Swimlanes: one per `project_key`, sorted by the most urgent column, then by `updated_at`. A lane with no live run collapses to one summary line.
3. Header toggles: **Show headless** and **Show stale (7d+)**. Both are off by default and map to the query parameters.
4. A card identifies the run by what it is working on:
   1. Top row: `name [worktree]` (or the title) and a harness mark (CC, CX, HM, PI).
   2. The goal, up to two lines. With no goal, the title when it differs from the headline.
   3. Where the work stands: a `blocked`, `handoff` or `done` chip, then the current step (else the summary) and `steps_done/steps_total`.
   4. Bottom row: the branch, the relative `updated_at`, cost or tokens, and a PR chip. A run in `gather_queue` shows **waiting to move**.
   5. The last prompt appears only in the hover tooltip, with the goal, summary, cwd and resume command.
5. A click calls `POST /api/agents/{id}/open`, and a toast shows the result. The page polls every 5 s.
6. **Select** switches the page to select mode: a click toggles a card's selection. **Gather N into a Space…** opens a dialog with the user desktops from `GET /api/macos/spaces` (the current one preselected), a preview of how each run moves, and **Close the panes they leave behind** (on by default).

## Privacy

1. `/api/agents/*` is served only by the local kernel. The gctrl-board Cloudflare Worker does not proxy it, so prompts and paths stay on the machine.
2. The kernel's host-allowlist middleware limits every route to loopback Host headers.
