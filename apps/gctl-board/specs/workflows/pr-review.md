# PR Review Conventions

Defines PR structure, review checklist, agent-authored PR rules, and merge strategy for gctl-board.

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

## Merge Strategy

1. Default merge strategy MUST be **squash merge** for feature branches.
2. The squash commit message MUST reference the Issue key (e.g., `feat(PROJECT-42): add rate limiting`).
3. Feature branches MUST be deleted after merge.
4. After merge, the linked Issue SHOULD auto-transition to `done`.
