# Skills — Claude Code Slash Commands

Implementation details for the Claude Code skill system defined in [specs/architecture/os.md](../architecture/os.md) § 6.

Skills are the outermost layer of gctl — opinionated prompts (`.claude/commands/*.md`) that invoke `gctl` CLI commands and reference spec files. This document covers the skill catalog, conventions, and the `gctl spec` utility that powers spec-focused skills.

---

## 1. Skill Catalog

### Shipped Skills

| Skill | Purpose | Category | Pattern | gctl Commands Used | Spec Context Loaded |
|-------|---------|----------|---------|-------------------|-------------------|
| `/audit-specs` | Check specs against principles and standards | Spec analysis | Transitional | (future: `gctl spec audit`) | `principles.md`, `AGENTS.md`, `architecture/README.md`, `architecture/os.md` |
| `/review-specs` | Identify spec gaps, contradictions, ambiguities | Spec analysis | Transitional | (future: `gctl spec review`) | All `specs/` files |
| `/status` | System health overview | Observability | Thin wrapper | `gctl status`, `gctl sessions`, `gctl analytics overview` | `architecture/os.md`, `architecture/domain-model.md` |
| `/cost-report` | Summarize cost and token usage | Observability | Thin wrapper | `gctl analytics cost`, `gctl analytics cost-breakdown`, `gctl analytics daily` | `architecture/domain-model.md` |
| `/trace` | Investigate a session's trace tree | Observability | Thin wrapper | `gctl tree <id>`, `gctl spans --session <id>`, `gctl sessions` | `architecture/domain-model.md` |
| `/dispatch` | Prepare dispatch recommendation for agent work | Orchestration | Transitional | `gctl sessions`, `gctl status`, `gctl analytics overview` | `architecture/os.md`, `architecture/tracker.md`, `principles.md` |

### Pattern Key

1. **Thin wrapper** — skill invokes existing `gctl` CLI commands and formats the output. This is the target pattern per os.md § 6.
2. **Transitional** — skill has Claude apply analysis logic from spec context directly, because the corresponding `gctl` CLI command does not yet exist. Each transitional skill MUST note which future command it will delegate to.

### Transitional Skill Tracker

| Skill | Blocked On | Target Command |
|-------|-----------|----------------|
| `/audit-specs` | `gctl spec audit` not implemented | `gctl spec audit --format json` |
| `/review-specs` | `gctl spec review` not implemented | `gctl spec review --format json` |
| `/dispatch` | `gctl board` and `gctl orchestrate` not implemented | `gctl board list --ready`, `gctl orchestrate dispatch` |

---

## 2. Skill Conventions

### File Structure

Every skill MUST follow this structure (the anatomy from os.md § 6):

```markdown
# .claude/commands/{skill-name}.md

One-line description of what the skill does.

## Instructions

### 1. Load Context
Read spec files relevant to the task.

### 2. Do the Work
Invoke gctl CLI commands or analyze loaded context.

### 3. Output Format
Structured output template.

$ARGUMENTS
```

### Rules (from os.md § 6)

1. **Thin wrappers only.** Skills MUST NOT contain business logic. They load context, invoke commands, and format output.
2. **Logic lives in gctl.** If a skill needs computation, the capability MUST exist as a `gctl` CLI command first.
3. **Grounded in specs.** Skills MUST load relevant `specs/` files — MUST NOT rely solely on Claude's training data for project-specific decisions.
4. **Skills compose gctl commands.** A skill MAY chain multiple commands and synthesize the results.
5. **Project-scoped.** Skills live in `.claude/commands/` and are versioned with the repo.

### Anti-Patterns (from os.md § 6)

1. **Fat skills** — A skill that parses DuckDB output, computes aggregates, or applies business rules inline. Move that logic into a `gctl` CLI command.
2. **Duplicate logic** — A skill that reimplements what `gctl analytics` or `gctl query` already provides. Invoke the command instead.
3. **Ungrounded skills** — A skill that does not load spec context and relies solely on Claude's training data for project-specific decisions. Always load the relevant specs.

### Transitional Pattern

Some skills currently operate by having Claude read and analyze spec files directly. This is acceptable as a **transitional pattern** while the corresponding `gctl` CLI commands are not yet implemented. Once the target command exists, the skill MUST be updated to invoke it instead.

The transitional pattern is:
1. Skill loads context from `specs/` files
2. Claude applies analysis logic described in the skill prompt
3. Skill formats and outputs results

The target pattern is:
1. Skill invokes `gctl <subcommand>` which does the analysis
2. Skill formats the CLI output for the user

Transitional skills MUST include a blockquote marker at the top noting their transitional status and the target command.

---

## 3. `gctl spec` Utility (Planned)

A planned utility for spec analysis, validation, and maintenance. This utility powers the spec-focused skills and is also usable standalone from the CLI.

### Subcommands

| Command | Description | Output |
|---------|------------|--------|
| `gctl spec audit` | Check specs against principles and documentation standards | Violations list with file, rule, severity |
| `gctl spec review` | Identify gaps, contradictions, ambiguities | Questions grouped by category and priority |
| `gctl spec list` | List all spec files with metadata | Table of files, last modified, word count |
| `gctl spec refs` | Validate cross-references between spec files | Broken links, orphaned files |
| `gctl spec diff <base>` | Show spec changes since a git ref | Changed files, added/removed sections |

### Implementation Notes

1. **Crate**: `gctl-spec` (Utility layer, lives in `crates/gctl-spec/`)
2. **No kernel dependency**: This utility reads Markdown files from the filesystem — it does not use DuckDB or the kernel
3. **CLI registration**: Subcommands registered in `gctl-cli/src/commands/spec.rs`
4. **Output formats**: `--format json`, `--format table`, `--format markdown`
5. **Rules engine**: Audit rules defined as a composable chain (similar to `GuardrailPolicy`) — each rule checks one thing

### Audit Rule Interface

```rust
/// A single spec audit rule.
pub trait AuditRule: Send + Sync {
    /// Human-readable rule name (e.g., "numbered-lists", "no-ascii-diagrams").
    fn name(&self) -> &str;

    /// Check a spec file and return violations.
    fn check(&self, path: &Path, content: &str) -> Vec<Violation>;
}

pub struct Violation {
    pub rule: String,
    pub file: PathBuf,
    pub line: Option<usize>,
    pub severity: Severity,
    pub message: String,
    pub suggestion: Option<String>,
}

pub enum Severity {
    Fail,
    Warn,
}
```

### Built-in Audit Rules

| Rule | What It Checks |
|------|---------------|
| `numbered-lists` | Lists of rules/principles/invariants use numbered lists, not bullets |
| `no-obsidian-syntax` | No wikilinks, callouts, empty-text links, block references |
| `mermaid-only` | No ASCII box-drawing characters in diagrams |
| `rfc2119-keywords` | MUST/SHOULD/MAY used consistently |
| `valid-cross-refs` | Relative links resolve to existing files |
| `no-broken-anchors` | Section references within files resolve |
| `table-namespacing` | SQL DDL uses `{app}_*` prefixed table names |
| `layer-placement` | Content matches the file's declared scope (per AGENTS.md table of contents) |

---

## 4. Skill Testing

Skills are tested by running them against the actual specs and verifying the output structure.

### Manual Testing

```sh
# Invoke each skill via Claude Code
/audit-specs
/review-specs
/status
/cost-report
/trace <session_id>
/dispatch <issue description>

# Verify output matches the expected format
# Check that violations found are real (not false positives)
```

### Automated Testing (via `gctl spec`)

Once `gctl spec audit` is implemented:

```sh
# Run audit as part of CI
gctl spec audit --format json | jq '.violations | length'

# Validate cross-references
gctl spec refs --format json

# Diff specs against main branch
gctl spec diff main --format markdown
```

---

## 5. Adding a New Skill

1. **Identify the gctl commands** the skill needs. If they don't exist, build the CLI command first (or use the transitional pattern and track it in the Transitional Skill Tracker above).
2. **Create** `.claude/commands/{skill-name}.md` following the file structure above.
3. **Load context** — always include the relevant `specs/` files so Claude is grounded.
4. **Define output format** — structured, consistent, actionable.
5. **Add to catalog** — update the Shipped Skills table in this file.
6. **If transitional** — add a blockquote marker in the skill file and an entry in the Transitional Skill Tracker.
7. **Test** — run the skill and verify output matches expectations.
