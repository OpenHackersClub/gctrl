# gctrl-inbox — Roadmap

> Milestones and slice breakdown for gctrl-inbox. See [PRD.md](PRD.md) for the problem, goals, and message model; [WORKFLOW.md](WORKFLOW.md) for lifecycle and triage flows.

## M0: Capture & Triage — In Progress

**Goal:** Agent requests-to-user reach the inbox in real time; the human can find and answer them with one click.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Kernel inbox intake | `inbox_*` tables + `/api/inbox/*` routes on the kernel | P0 | — | Shipped |
| mac-comm focus driver | `gctrl://focus/...` deeplink + `/api/comm/focus` (see `vault/specs/architecture/kernel/mac-comm.md`) | P0 | Kernel inbox intake | Shipped (PR-1) |
| CC observe capture hook | `Notification` + `AskUserQuestion` hooks → fire-and-forget POST to `/api/inbox/messages` with `context.terminal` | P0 | Kernel inbox intake | [#215](https://github.com/OpenHackersClub/gctrl/issues/215) |
| CC blocking permission hook (act mode) | `PreToolUse` hook polls the inbox message; approve/deny from the inbox resumes/blocks Claude Code | P1 | CC observe capture hook, mac-comm focus driver | TBD |
| Transcript enrichment | Kernel one-shot read of `payload.transcript_path` at message creation to enrich the inbox card | P2 | CC observe capture hook | TBD |
| Desktop hook install | gctrl-desktop first-run copies `shell/hooks/*.sh` into `~/.local/share/gctrl/hooks/` | P2 | CC observe capture hook | TBD |

**Done when:** a permission prompt in any Claude Code session appears in the inbox within a second, carries a working Focus deeplink, and stale prompts expire on their own.
