# gctl Workflow

How work flows through gctl — from ideation to merged PR. This is gctl's own workflow, dogfooding the templates defined in `specs/gctl/workflows/`.

> **Templates used**: This workflow instantiates the reusable gctl workflow templates with gctl-specific values (project keys, agent names, sync targets). See [specs/gctl/workflows/README.md](gctl/workflows/README.md) for the full template catalog.

---

## 1. Task Planning

Follows [task-planning.md](gctl/workflows/task-planning.md) template.

Tasks are local planning artifacts managed via `gctl task`. They let agents and humans break down vague goals before creating Issues.

### gctl-Specific CLI

```sh
gctl task create "Investigate rate limit approaches"
gctl task decompose TASK-1 --sub "Middleware" --sub "Tests" --sub "Docs"
gctl task graph
gctl task ready

gctl task promote TASK-2 --project BACK --priority high \
  --criteria "100req/s sustained" --criteria "No regression"
# → Creates BACK-42, syncs to GitHub Issue #42

gctl task done TASK-1 --note "Decided on token bucket approach"
gctl task list
gctl task list --status blocked
gctl task list --orphan
```

---

## 2. Issue Lifecycle

Follows [issue-lifecycle.md](gctl/workflows/issue-lifecycle.md) template.

gctl uses the standard kanban lifecycle with project key prefix `BACK-*` (or per-project keys).

---

## 3. GitHub Sync

Issues sync bidirectionally with GitHub Issues. The local `gctl-board` state is the source of truth for the kanban lifecycle; GitHub Issues is the source of truth for external visibility and cross-repo references.

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

1. Sync MUST be triggered by `gctl board sync` or on a configurable schedule (via the scheduler kernel primitive).
2. Conflict resolution: **last-write-wins with local preference** — if both sides changed the same field since last sync, the local value wins and a warning is logged.
3. Agent-internal comments SHOULD NOT sync to GitHub by default.
4. GitHub Issue numbers MUST be stored on the local Issue for stable cross-referencing.

### CLI

```sh
gctl board sync --project BACK
gctl board sync --all
gctl board sync --dry-run
gctl board sync --direction push    # local → GitHub only
gctl board sync --direction pull    # GitHub → local only
```

---

## 4. PR Review

Follows [pr-review.md](gctl/workflows/pr-review.md) template.

gctl-specific additions:

- Reviewers SHOULD check crate ownership rules (see `specs/principles.md`, Crate Ownership #1-5).
- Reviewers SHOULD check architectural invariants (see `specs/principles.md`, Architectural Invariants #1-5).
- Squash commit messages use conventional commits with project key: `feat(BACK-42): add rate limiting`.

---

## 5. End-to-End Example

```
1. Planning (local, Tasks)
   gctl task create "Rate limiting for /api/users"
   gctl task decompose TASK-1 --sub "Middleware" --sub "Tests" --sub "Docs"
   gctl task graph

2. Commit to work (promote to Issues)
   gctl task promote TASK-1-1 --project BACK --priority high \
     --criteria "100req/s sustained" --criteria "No regression"
   → Creates BACK-42, syncs to GitHub Issue #42

3. Agent claims and works
   gctl board assign BACK-42 --agent claude-code
   gctl board move BACK-42 in_progress
   # ... agent works, sessions auto-linked ...

4. PR opened
   gctl board move BACK-42 in_review --link-pr 891
   # or auto-detected from PR body "Closes #42"

5. Human reviews (see Section 4)

6. PR merged
   gctl board move BACK-42 done       # or auto-transition
   gctl board sync --project BACK     # sync status to GitHub

7. Downstream unblocked
   # BACK-43 (blocked by BACK-42) auto-transitions to todo
```

---

## 6. WORKFLOW.md File Format

Follows [workflow-file.md](gctl/workflows/workflow-file.md) template.

gctl applications MAY define a `WORKFLOW.md` file in their repository root to configure automated agent dispatch. The file uses YAML frontmatter for configuration and a Markdown body as the per-issue prompt template.

See the template for the full schema (tracker, polling, workspace, hooks, agent settings).
