# gctrl Workflow

How work flows through gctrl — from ideation to merged PR. This is gctrl's own workflow.

> **Workflow specs**: Opinionated product workflows (issue lifecycle, product cycle, PR review, PRD template) live in `apps/gctrl-board/specs/workflows/`. Kernel-level orchestration and dispatch are defined in `specs/architecture/kernel/`.

---

## 1. Task Planning

Task planning (decomposition, dependency DAG, promotion to issues) is handled internally by the kernel Scheduler. See [specs/architecture/kernel/scheduler.md](../../architecture/kernel/scheduler.md).

### gctrl-Specific CLI

```sh
gctrl task create "Investigate rate limit approaches"
gctrl task decompose TASK-1 --sub "Middleware" --sub "Tests" --sub "Docs"
gctrl task graph
gctrl task ready

gctrl task promote TASK-2 --project BACK --priority high \
  --criteria "100req/s sustained" --criteria "No regression"
# → Creates BACK-42, syncs to GitHub Issue #42

gctrl task done TASK-1 --note "Decided on token bucket approach"
gctrl task list
gctrl task list --status blocked
gctrl task list --orphan
```

---

## 2. Issue Lifecycle

Follows [issue-lifecycle.md](../../apps/gctrl-board/specs/workflows/issue-lifecycle.md).

gctrl uses the standard kanban lifecycle with project key prefix `BACK-*` (or per-project keys).

---

## 3. GitHub Sync

Issues sync bidirectionally with GitHub Issues. The local `gctrl-board` state is the source of truth for the kanban lifecycle; GitHub Issues is the source of truth for external visibility and cross-repo references.

### Sync Direction

| Field | Local → GitHub | GitHub → Local |
|-------|---------------|----------------|
| Title | Yes | Yes |
| Description / body | Yes | Yes |
| Status → labels | `in_progress` → label `status:in-progress`, etc. | Label changes → status updates |
| Assignee | Yes (agent → unassigned on GitHub, or mapped user) | Yes |
| Labels | Yes | Yes |
| PR links | Yes (from `prNumbers`) | Yes (auto-detect from PR body `Closes #N`) |
| Comments | Selected (agent summaries) | All |
| Acceptance criteria | Rendered as checklist in body | Parsed from checklist |

### Sync Rules

1. Sync MUST be triggered by `gctrl board sync` or on a configurable schedule (via the scheduler kernel primitive).
2. Conflict resolution: **last-write-wins with local preference** — if both sides changed the same field since last sync, the local value wins and a warning is logged.
3. Agent-internal comments SHOULD NOT sync to GitHub by default.
4. GitHub Issue numbers MUST be stored on the local Issue for stable cross-referencing.

### CLI

```sh
gctrl board sync --project BACK
gctrl board sync --all
gctrl board sync --dry-run
gctrl board sync --direction push    # local → GitHub only
gctrl board sync --direction pull    # GitHub → local only
```

---

## 4. PR Review

Follows [pr-review.md](../../apps/gctrl-board/specs/workflows/pr-review.md).

gctrl-specific additions:

- Reviewers SHOULD check crate ownership rules (see `specs/principles.md`, Crate Ownership #1-5).
- Reviewers SHOULD check architectural invariants (see `specs/principles.md`, Architectural Invariants #1-5).
- Squash commit messages use conventional commits with project key: `feat(BACK-42): add rate limiting`.

---

## 5. End-to-End Example

```
1. Planning (local, Tasks)
   gctrl task create "Rate limiting for /api/users"
   gctrl task decompose TASK-1 --sub "Middleware" --sub "Tests" --sub "Docs"
   gctrl task graph

2. Commit to work (promote to Issues)
   gctrl task promote TASK-1-1 --project BACK --priority high \
     --criteria "100req/s sustained" --criteria "No regression"
   → Creates BACK-42, syncs to GitHub Issue #42

3. Agent claims and works
   gctrl board assign BACK-42 --agent claude-code
   gctrl board move BACK-42 in_progress
   # ... agent works, sessions auto-linked ...

4. PR opened
   gctrl board move BACK-42 in_review --link-pr 891
   # or auto-detected from PR body "Closes #42"

5. Human reviews (see Section 4)

6. PR merged
   gctrl board move BACK-42 done       # or auto-transition
   gctrl board sync --project BACK     # sync status to GitHub

7. Downstream unblocked
   # BACK-43 (blocked by BACK-42) auto-transitions to todo
```

---

## 6. WORKFLOW.md File Format

See [specs/architecture/kernel/workflow-format.md](../architecture/kernel/workflow-format.md) for the full file format specification.

gctrl applications MAY define a `WORKFLOW.md` file in their repository root to configure automated agent dispatch. The file uses YAML frontmatter for configuration and a Markdown body as the per-issue prompt template.
