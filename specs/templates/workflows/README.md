# gctl Workflow Templates

Reusable templates and specifications for applications built on gctl. Any application (including gctl itself) can adopt these templates to define its workflows.

## Available Templates

| Template | Purpose | Used by |
|----------|---------|---------|
| [_PRODUCT_CYCLE.md](_PRODUCT_CYCLE.md) | Sprint cycle — plan, iterate (agent-autonomous), show & tell | `specs/gctl/workflows` (gctl dogfooding) |
| [_ISSUE_LIFECYCLE.md](_ISSUE_LIFECYCLE.md) | Kanban lifecycle for issues — statuses, transition rules, auto-transitions | `specs/gctl/workflows` (gctl dogfooding) |
| [_TASK_PLANNING.md](_TASK_PLANNING.md) | Local task decomposition, dependency DAG, promotion to issues | `specs/gctl/workflows` (gctl dogfooding) |
| [_WORKFLOW_FILE.md](_WORKFLOW_FILE.md) | `WORKFLOW.md` file format — YAML frontmatter + prompt template for agent dispatch | Any gctl application using agent orchestration |
| [_PR_REVIEW.md](_PR_REVIEW.md) | PR structure, review checklist, agent-authored PR conventions, merge strategy | `specs/gctl/workflows` (gctl dogfooding) |
| [_ORCHESTRATION.md](_ORCHESTRATION.md) | Kernel-level orchestration state machine — dispatch, retry, reconciliation for agent work | Kernel primitive (`gctl-orch`), exposed via `gctl orchestrate` CLI |

## How to Use

Applications built on gctl adopt these templates by referencing them in their own workflow docs. The application's `workflow.md` (or equivalent) instantiates the templates with project-specific values (project keys, agent names, sync targets, etc.).

Since gctl dogfoods itself, `specs/gctl/workflows` is the first consumer of these templates.
