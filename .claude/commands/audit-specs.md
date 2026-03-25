Audit the gctl specs for compliance with the project's principles, guidelines, and documentation standards.

> **Transitional skill**: Claude applies audit rules directly from spec context. Once `gctl spec audit` is implemented (see `specs/implementation/skills.md` § 3), this skill MUST be updated to invoke that command instead.

## Instructions

You are performing a spec audit. This skill is a thin wrapper — it loads the rules from gctl specs, applies them to every file under `specs/`, and reports violations.

### 1. Load the Rules

Read these files to understand the rules:

- `specs/principles.md` — Unix philosophy, design principles, vendor independence, architectural invariants, crate ownership, Effect-TS invariants, testing invariants, git workflow
- `AGENTS.md` — Documentation standards, specs table of contents, invariants quick reference
- `specs/architecture/README.md` — Unix layers, hexagonal architecture, data flow
- `specs/architecture/os.md` — Layer definitions, what belongs where, extension rules

### 2. Load the Spec Files

Read every `.md` file under `specs/` to audit.

### 3. Apply Checklist

For each spec file, check:

**Documentation Standards (AGENTS.md)**
1. All lists of rules, principles, constraints use numbered lists (not bullets)
2. Raw CommonMark/GFM only — no Obsidian syntax (`[[...]]`, `> [!note]`, `[](url)`, `^block-id`)
3. All diagrams use Mermaid — no ASCII box-drawing characters
4. RFC 2119 keywords used correctly (MUST, SHOULD, MAY) with instructive language

**Layer Placement (os.md)**
1. Kernel specs describe mechanisms, not policy
2. Application specs do not reference kernel internals directly
3. Utility specs describe single-purpose tools that compose
4. No spec places content in the wrong layer

**Unix Philosophy (principles.md)**
1. Each component does one thing (tenet #1)
2. Mechanisms separated from policy (tenet #4)
3. No unnecessary complexity or mandatory dependencies (tenet #6)
4. Observability requirements present where state changes occur (tenet #7)
5. Error handling specifies what went wrong and what to do next (tenet #12)
6. New features don't require modifying existing kernel specs (tenet #17)

**Architectural Invariants (principles.md)**
1. Dependencies flow inward: Shell → Kernel → Domain (never reverse)
2. DuckDB single-writer constraint respected
3. Application tables use namespaced prefixes
4. Kernel makes no assumptions about applications
5. Shell mediates all external access to kernel

**Spec Organization (AGENTS.md)**
1. Content is in the right file per specs table of contents
2. No duplication — each fact lives in exactly one place
3. Implementation details in `specs/implementation/`, not in architecture specs
4. Cross-references use relative paths and are not broken

### 4. Output Format

For each file audited:

```
### specs/<path>

**Status**: PASS | WARN | FAIL

**Violations** (if any):
1. [RULE] Description of violation — suggested fix
2. [RULE] ...

**Notes** (optional observations that aren't violations):
- ...
```

Group results by severity: FAIL first, then WARN, then PASS.

End with a summary:

```
## Summary

- Files audited: N
- PASS: N
- WARN: N (minor issues)
- FAIL: N (violations that MUST be fixed)

### Top Issues
1. Most common violation and where it appears
2. ...
```

$ARGUMENTS
