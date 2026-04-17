# Product Requirements Document Template

A lightweight PRD template for gctrl-board projects. Captures the **why** and **what** — business motivation, goals, use cases, and a roadmap that translates directly into issues.

The PRD is NOT an architecture doc. It answers "what problem are we solving and what does success look like?" — not "how do we build it."

---

## How to Use

1. Copy this template into your project's directory (e.g., `specs/gctrl/PRD.md` or `apps/gctrl-board/PRD.md`).
2. Fill in each section. Delete sections that don't apply.
3. The Roadmap section should produce issues: each milestone/feature maps to one or more gctrl-board issues.
4. Review the PRD before sprint planning. Update it as priorities shift.

---

## Template

```markdown
# {Project Name} — Product Requirements Document

> One-sentence description of what this project does and who it's for.

## Problem

What pain exists today? Why does this project need to exist?

1. **{Problem 1}** — describe the pain, who feels it, what it costs.
2. **{Problem 2}** — ...
3. **{Problem 3}** — ...

## Our Take

What is the fundamental insight or approach that solves these problems? Why will this work when alternatives haven't? This is the "thesis" — the non-obvious bet.

## Principles

Numbered list of design principles that guide decisions. When two features conflict, these break the tie.

1. **{Principle 1}** — ...
2. **{Principle 2}** — ...

## Target Users

### Primary: {User Persona 1}

Who are they? What do they need? What does day-one value look like?

| Need | Solution |
|------|----------|
| "{User need}" | {What they use in the product} |

### Secondary: {User Persona 2}

Same format. What additional value do they get?

## Use Cases

Concrete scenarios. Each use case should be testable — you can verify whether the product actually handles it.

### 1. {Use Case Name}

**Problem:** ...
**Solution:** ...
**Success metric:** ...

### 2. {Use Case Name}

...

## What We're Building

High-level description of capabilities. NOT architecture — describe what users/agents can do, not how it's built internally.

### {Capability 1}

What it does, why it matters, who uses it.

### {Capability 2}

...

## Roadmap

Each milestone maps to a set of issues. Use this to generate gctrl-board issues.

### M1: {Milestone Name} — {Target Date}

| Feature | Description | Priority | Issue |
|---------|-------------|----------|-------|
| {Feature 1} | What it delivers | P0/P1/P2 | {PROJ-N or TBD} |
| {Feature 2} | ... | ... | ... |

**Done when:** {Concrete acceptance criteria for the milestone}

### M2: {Milestone Name} — {Target Date}

...

### Backlog (unprioritized)

Features we want but haven't scheduled:

- {Feature idea}
- {Feature idea}

## Non-Goals

What this project explicitly does NOT do. Prevents scope creep.

- **Not {X}.** Why: ...
- **Not {Y}.** Why: ...

## Success Criteria

How we know the project is working. Measurable where possible.

1. {Metric or observable outcome}
2. {Metric or observable outcome}

## Open Questions

Decisions not yet made. Each should be resolved before the relevant milestone.

- [ ] {Question} — needed by {milestone}
- [ ] {Question} — needed by {milestone}
```

---

## Generating Issues from the Roadmap

The Roadmap section is designed to feed directly into `gctrl board`:

```sh
# Create issues from milestone features
gctrl board create --project PROJ --title "Feature 1" --priority p0 --label m1
gctrl board create --project PROJ --title "Feature 2" --priority p1 --label m1

# Set milestone dependencies
gctrl board block PROJ-2 --by PROJ-1
```

Each row in the Roadmap table becomes an issue. The milestone label groups them. Dependencies between features become `blockedBy` edges in the issue DAG.

## Keeping the PRD Alive

- Update the PRD when priorities shift — don't let it drift from reality.
- Move completed milestones to a "Completed" section or delete them.
- Open Questions should shrink over time. If a question stays open past its milestone, escalate.
- The PRD is a living document, not a one-time artifact.
