# Template: Task Planning & Dependency Graph

Defines the local task decomposition workflow — lightweight planning before committing to issues. Applications adopt this template for pre-issue planning.

## Task vs Issue

| Concept | Scope | Lifecycle | Synced externally? |
|---------|-------|-----------|-------------------|
| **Task** | Local, pre-commit planning | Created → decomposed → dependency-resolved → promoted to Issue | No — local only until promoted |
| **Issue** | Committed, trackable work | Kanban lifecycle (see [issue-lifecycle.md](issue-lifecycle.md)) | Yes — bidirectional sync |

## When to Use Tasks

1. Breaking down a vague goal into concrete steps before creating Issues.
2. An agent is exploring feasibility and the work may not materialize into an Issue.
3. Modeling dependencies between planned work items before publishing them.

Tasks MUST NOT be synced externally. They are local planning artifacts.

## Dependency Graph (DAG)

Tasks and Issues form a directed acyclic graph:

```
Task/Issue A  ──blocks──▶  Task/Issue B
              (A must complete before B can start)
```

1. Both Tasks and Issues MAY have `blockedBy` and `blocking` relationships.
2. The dependency graph MUST be acyclic — reject edges that would create cycles.
3. When a blocking item completes, blocked items SHOULD auto-transition to `todo`.

## Promotion: Task → Issue

When a Task is promoted:
1. Create an issue record with the Task's title, description, and acceptance criteria.
2. Preserve dependency edges — if Task A blocks Task B and both are promoted, the resulting Issues maintain the relationship.
3. Sync the new Issue to the external tracker.
4. Archive the original Task (MUST NOT delete — keep for audit trail).

## CLI Surface (Template)

Applications SHOULD expose these commands (names may vary):

```sh
# Create and decompose
gctl task create "Description"
gctl task decompose TASK-1 --sub "Step 1" --sub "Step 2"

# View dependencies
gctl task graph                    # DAG as mermaid or ASCII
gctl task ready                    # list unblocked tasks

# Promote to issue
gctl task promote TASK-2 --project KEY --priority high \
  --criteria "Criterion 1" --criteria "Criterion 2"

# Complete
gctl task done TASK-1 --note "Resolution notes"
```
