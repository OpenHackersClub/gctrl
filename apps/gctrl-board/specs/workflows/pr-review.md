# PR Review Conventions

Defines PR structure, review checklist, agent-authored PR rules, and merge strategy for gctrl-board.

## PR Structure

Every PR MUST follow this structure:

```markdown
## Summary
- 1-3 bullet points describing the change

## Linked Issues
- Closes PROJECT-42
- Related to PROJECT-40

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass (if applicable)
- [ ] Manual verification steps (if applicable)

## Agent Context (auto-generated)
- Sessions: sess-4821, sess-4822
- Total cost: $1.24
- Models used: claude-opus-4-6
```

## Review Checklist

Reviewers SHOULD verify:

1. **Correctness** — Does the code do what the Issue acceptance criteria require?
2. **Tests** — Are there tests for new behavior? Do existing tests still pass?
3. **Boundaries** — Does the change respect module/crate ownership?
4. **Invariants** — Does the change violate any architectural invariant?
5. **Scope** — Is the PR focused on one Issue? Split multi-concern PRs.

## Agent-Authored PRs

PRs authored by agents MUST:
1. Include the `Agent Context` section with linked sessions and cost.
2. Be reviewed by a human before merge — agents MUST NOT self-merge.
3. Include `Co-Authored-By: <agent> <noreply@anthropic.com>` in the commit message.

PRs authored by agents SHOULD:
1. Be smaller and more focused than human PRs — one Issue per PR.
2. Include a note if the agent encountered difficulties (error loops, retries).

## Agent Handoff via Issue Comments

Agents hand off work to other agents (or humans) by **commenting on the linked Issue**, not by DM-ing, not by editing the PR description, not by posting to the PR thread alone.

The Issue is the durable artifact — PRs come and go, but the Issue persists across PRs, branches, and agent identities. Posting handoff context to the Issue means the next picker-up — whether that's a different agent (e.g. `opencode` running `gemma-3-26b` reviewing a `claude-code` WIP PR), the same agent on a fresh session, or a human — has a single chronological place to read what's been done and what's expected next.

### When to post a handoff comment

Post a comment on the linked Issue when:

1. **Opening a PR** — summarize what's implemented, what's deferred, and what the next agent should verify or extend.
2. **Requesting review from another agent** — name the agent, the model, and the specific question (e.g. "spec correctness", "perf regression risk", "API surface review"). The reviewing agent reads its assignment from the Issue.
3. **Returning a review** — the reviewing agent posts findings as a comment on the Issue. Inline PR comments are fine *in addition* but are not a substitute — they're not visible from the board.
4. **Pausing or yielding** — when an agent stops mid-Issue (cost cap, ambiguity, blocker), it MUST leave a comment describing state and what unblocks the next attempt.
5. **Completing an acceptance criterion partially** — note which criteria are satisfied so the next agent doesn't redo the work.

### Comment shape

Handoff comments SHOULD use a `## Agent: <name>` header so the orchestrator and board UI can group them. Body conventions:

```markdown
## Agent: opencode (gemma-3-26b)

**Role:** Review WIP PR #123 against acceptance criteria.

**Findings:**
- Criterion 1 (rate limiting) — implemented, tests cover happy path only
- Criterion 2 (audit log) — not yet implemented

**Handing off to:** claude-code — please add error-path tests for criterion 1 and implement criterion 2.
```

### What does NOT belong in a handoff comment

- Long diffs or full file dumps — link to the PR or commit instead.
- Internal agent reasoning traces — keep those in session telemetry.
- Status changes — those go through `gctrl board move`, which emits its own event.

### Why issue, not PR

| Concern | Issue comment | PR comment |
|---------|--------------|------------|
| Survives PR close / re-open | ✅ | ❌ |
| One thread across multiple PRs for the same Issue | ✅ | ❌ |
| Visible in board UI alongside session/cost data | ✅ | ❌ |
| Picked up by orchestrator dispatch | ✅ | ❌ |
| Useful for inline code-line discussion | ❌ | ✅ |

Inline code-level discussion still belongs on the PR. Handoff and review *summary* belong on the Issue.

## Merge Strategy

1. Default merge strategy MUST be **squash merge** for feature branches.
2. The squash commit message MUST reference the Issue key (e.g., `feat(PROJECT-42): add rate limiting`).
3. Feature branches MUST be deleted after merge.
4. After merge, the linked Issue SHOULD auto-transition to `done`.
