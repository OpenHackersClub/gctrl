# Roadmap Template

A lightweight roadmap template for gctrl-board projects. Captures milestones, task breakdowns, acceptance criteria, and open questions — separate from the PRD so the two can evolve at different cadences.

The PRD answers "what and why." The roadmap answers "when and in what order."

---

## How to Use

1. Copy this template into your project's directory (e.g., `specs/gctrl/ROADMAP.md` or `apps/gctrl-board/ROADMAP.md`).
2. Fill in milestones from the PRD's high-level capabilities.
3. Each milestone produces gctrl-board issues: one row per task, linked to an issue ID.
4. Update the roadmap as work completes — move shipped items, reprioritize, add new milestones.
5. Keep Open Questions shrinking. If a question outlives its milestone, escalate.

---

## Template

```markdown
# {Project Name} — Roadmap

> Milestones and task breakdown. See [PRD.md](PRD.md) for the problem, goals, and design principles.

## M1: {Milestone Name} — {Status: Shipped | In Progress | Planned}

**Goal:** One sentence describing what this milestone delivers.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| {Task 1} | What it delivers | P0/P1/P2 | {dependency} | {PROJ-N or TBD} |
| {Task 2} | ... | ... | ... | ... |

**Done when:** {Concrete acceptance criteria — a testable statement, not a vague goal.}

## M2: {Milestone Name} — {Status}

**Goal:** ...

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| ... | ... | ... | ... | ... |

**Done when:** ...

## Backlog (unprioritized)

Features we want but haven't scheduled:

- {Feature idea}
- {Feature idea}

## Open Questions

Decisions not yet made. Each MUST reference the milestone that needs it resolved.

- [ ] {Question} — needed by {milestone}
- [ ] {Question} — needed by {milestone}
```

---

## Generating Issues from the Roadmap

Each row in a milestone table maps to a gctrl-board issue:

```sh
# Create issues from milestone tasks
gctrl board create --project PROJ --title "Task 1" --priority p0 --label m1
gctrl board create --project PROJ --title "Task 2" --priority p1 --label m1

# Set dependencies between tasks
gctrl board block PROJ-2 --by PROJ-1
```

The milestone label groups related issues. The `Depends On` column becomes `blockedBy` edges in the issue DAG.

## Keeping the Roadmap Alive

1. Update status as milestones ship — move completed milestones to the top with "Shipped" status.
2. Reprioritize between milestones when the PRD's goals shift.
3. Fill in Issue IDs as tasks are created in gctrl-board — `TBD` rows are planning debt.
4. Open Questions MUST shrink over time. Stale questions block milestones.
5. The roadmap is a living document — review it at every sprint planning (see [product-cycle.md](product-cycle.md)).
