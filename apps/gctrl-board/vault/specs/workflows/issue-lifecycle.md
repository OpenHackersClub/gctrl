# Issue Lifecycle (Kanban)

Defines the kanban lifecycle for issues tracked by gctrl-board. Statuses, transition rules, and auto-transition triggers are owned by this application.

> The state machine enforces forward-only ordering, terminal convergence, and universal cancel.

## Statuses

`backlog` → `todo` → `in_progress` → `in_review` → `done` (any non-terminal → `cancelled`)

| Status | Who moves here | What it means |
|--------|---------------|---------------|
| `backlog` | Human or agent | Captured but not prioritized. No commitment. |
| `todo` | Human (sprint planning) or auto-unblock | Prioritized and ready to start. Acceptance criteria defined. |
| `in_progress` | Agent or human claiming the Issue | Active work happening. Agent sessions auto-linked. |
| `in_review` | Agent (after PR opened) | Implementation complete. PR open, awaiting review. |
| `done` | Human (after PR merged) or auto-close | PR merged, acceptance criteria met. Terminal. |
| `cancelled` | Human | Work abandoned or superseded. MUST include a reason. Terminal. |

## Transition Side-Effects (Application-Level)

These are enforced by the Tracker at the application API boundary, not in the state machine:

1. An Issue MUST NOT move to `in_progress` without at least one acceptance criterion.
2. An Issue MUST NOT move to `in_review` without a linked PR.
3. An Issue SHOULD auto-transition to `in_review` when a PR referencing it is opened.
4. An Issue SHOULD auto-transition to `done` when the linked PR is merged.
5. Moving to `cancelled` MUST include a note explaining why.
6. Agents handing off work to another agent or human SHOULD post a comment on the Issue describing what's done and what the next picker-up should do — see [pr-review.md § Agent Handoff via Issue Comments](pr-review.md#agent-handoff-via-issue-comments). The Issue (not the PR thread) is the durable handoff surface so the convention works across PR-less work, multi-PR Issues, and cross-agent reviews (e.g. `opencode` reviewing a `claude-code` WIP PR).

## Issue Requirements

Issues MUST have:
1. A clear title and acceptance criteria.
2. A status from the kanban lifecycle above.
3. A project key prefix (e.g., `BACK-42`).
