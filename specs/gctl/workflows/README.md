# gctl Workflow Templates

Reusable templates and specifications for applications built on gctl. Any application (including gctl itself) can adopt these templates to define its workflows.

## Available Templates

| Template | Purpose | Used by |
|----------|---------|---------|
| [product-cycle.md](product-cycle.md) | Sprint cycle — plan, iterate (agent-autonomous), show & tell | `specs/workflow.md` (gctl dogfooding) |
| [issue-lifecycle.md](issue-lifecycle.md) | Kanban lifecycle for issues — statuses, transition rules, auto-transitions | `specs/workflow.md` (gctl dogfooding) |
| [task-planning.md](task-planning.md) | Local task decomposition, dependency DAG, promotion to issues | `specs/workflow.md` (gctl dogfooding) |
| [workflow-file.md](workflow-file.md) | `WORKFLOW.md` file format — YAML frontmatter + prompt template for agent dispatch | Any gctl application using agent orchestration |
| [pr-review.md](pr-review.md) | PR structure, review checklist, agent-authored PR conventions, merge strategy | `specs/workflow.md` (gctl dogfooding) |
| [orchestration.md](orchestration.md) | Kernel-level orchestration state machine — dispatch, retry, reconciliation for agent work | Kernel primitive (`gctl-orch`), exposed via `gctl orchestrate` CLI |

## How to Use

Applications built on gctl adopt these templates by referencing them in their own workflow docs. The application's `workflow.md` (or equivalent) instantiates the templates with project-specific values (project keys, agent names, sync targets, etc.).

Since gctl dogfoods itself, `specs/workflow.md` is the first consumer of these templates.
