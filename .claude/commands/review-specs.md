Review the gctl specs to identify gaps, contradictions, and ambiguities — then ask clarifying questions.

> **Transitional skill**: Claude applies review analysis directly from spec context. Once `gctl spec review` is implemented (see `specs/implementation/skills.md` § 3), this skill MUST be updated to invoke that command instead.

## Instructions

You are performing a spec review focused on **completeness and consistency**. Unlike `/audit-specs` (which checks compliance with rules), this skill identifies what is **missing, contradictory, or unclear** and asks the user to clarify.

### 1. Load Context

Read these files to build your mental model of the system:

- `specs/principles.md` — Design principles, invariants, vendor independence
- `AGENTS.md` — Specs table of contents, documentation standards, invariants
- `specs/architecture/README.md` — Unix layers, hexagonal architecture, data flow
- `specs/architecture/os.md` — Layer definitions, what belongs where, extension rules
- `specs/architecture/domain-model.md` — Domain types, storage schema
- `specs/architecture/tracker.md` — Issue & task graph, lifecycle state machines
- `specs/architecture/gctl-board.md` — Board application
- `specs/prd.md` — Product requirements (skim for feature scope)
- `specs/implementation/components.md` — Crate/package map
- `specs/implementation/repo.md` — Monorepo structure (Rust, Effect-TS, Lean 4)
- `specs/implementation/orchestration.md` — Orchestration implementation
- `specs/implementation/skills.md` — Skill catalog and conventions

### 2. Analyze for Gaps

For every spec file under `specs/`, look for:

**Missing Parts**
- Undefined terms or concepts referenced but never specified
- Features in prd.md without a corresponding architecture or implementation spec
- Ports/traits declared but no adapter or implementation spec
- State machines with missing transitions or unhandled edge cases
- Storage tables referenced but missing from domain-model.md DDL
- Error types listed but no recovery strategy defined
- Cross-references pointing to files or sections that don't exist
- CLI commands described in prd.md but no implementation spec

**Contradictions**
- Two specs defining the same concept differently (status enums, table schemas, transition rules)
- A principle in `principles.md` violated by a concrete spec elsewhere
- Dependency direction violations (kernel spec referencing an application)
- Conflicting ownership (two specs claiming the same table or CLI command)
- Type definitions differing between Rust (domain-model.md) and Effect-TS schemas
- Feature described as "required" in one place and "optional" in another
- Layer placement in os.md contradicted by actual spec content

**Ambiguities**
- Vague language where precision is needed ("should handle errors appropriately", "sync periodically")
- Decision points left open without an ADR or explicit "deferred" marker
- Underspecified interfaces (what happens on failure? edge cases?)
- Configuration values referenced but no defaults or valid ranges specified

### 3. Formulate Questions

For each finding, formulate a **specific, actionable question**. Each question MUST:

1. Reference the exact file(s) and section(s) where the gap lives
2. Explain *what* is missing or contradictory (with enough context)
3. Suggest 2-3 possible resolutions where applicable

### 4. Output Format

Group questions by category and priority:

```
## Contradictions (resolve first)

### C1. [specs/file-a.md vs specs/file-b.md] — Short description
**Context:** File A says X (line ~N). File B says Y (line ~M).
**Question:** Which is correct? Options:
  a) Keep X, update file B
  b) Keep Y, update file A
  c) Neither — the correct answer is: ___

## Missing Parts (gaps to fill)

### M1. [specs/file.md] — Short description
**Context:** Section Z references "FooPort" but no spec defines it.
**Question:** Should this be specified in architecture/ or implementation/?

## Ambiguities (clarify intent)

### A1. [specs/file.md] — Short description
**Context:** Section Z says "sync periodically" without specifying interval.
**Question:** What is the intended default? Options:
  a) Fixed 5-minute interval
  b) Configurable with 5m default
  c) Event-driven + periodic fallback

## Summary

- Files reviewed: N
- Contradictions found: N
- Missing parts found: N
- Ambiguities found: N
- Total questions: N
```

### 5. Prioritization

Order questions within each category by impact:
1. **Blocking** `[blocking]` — Would prevent implementation if not resolved
2. **Important** `[important]` — Would cause rework later if assumptions are wrong
3. **Minor** `[minor]` — Worth clarifying but a reasonable default could be assumed

$ARGUMENTS
