# AGENTS.md

## Overview

GroundCtrl (gctl) is a local-first operating system for human+agent teams. Follows the **Unix layered model**: a **Kernel** (Rust — telemetry, storage, guardrails, query, network, browser, sync; exposes HTTP API on `:4318`), a **Shell** (Effect-TS CLI — invokes kernel via HTTP, communicates with external tools like GitHub via `ccli`), **Native Applications & Utilities** (Effect-TS — board, eval, capacity), and **External Applications** (Linear, Plane, Notion, Phoenix — connected via drivers). DuckDB storage. Unix philosophy throughout; DDD for domain modeling.

**Dogfooding:** We use gctl to build gctl. gctl's own issue tracking, agent dispatch, and PR workflow are defined in `specs/gctl/`. Opinionated product workflows (issue lifecycle, sprint cycle, PR review, PRD template) live in `apps/gctl-board/specs/workflows/`. Kernel-level orchestration and dispatch format are defined in `specs/architecture/kernel/`. The telemetry, task tracking, guardrails, and CLI tools are exercised daily during development. If a feature isn't useful for building gctl itself, question whether it belongs. Bugs found during dogfooding are the highest-priority fixes.

## Specs Table of Contents

The `specs/` directory is the single source of truth. Each file has a clear scope — put content in the right place.

### Glossary

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/glossary.md` | Term definitions | Canonical definitions for all domain terms (Task, Session, Issue, Span, User, Persona, AgentKind, Driver, etc.). When a term is used in specs, it MUST carry the meaning defined here. |

### Product & Strategy

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/gctl/PRD.md` | Product requirements | Goals, non-goals, use cases, roadmap (→ issues), success criteria. Instantiates the [PRD template](apps/gctl-board/specs/workflows/prd-template.md). MUST NOT contain architecture or implementation details. |

### Architecture & Boundaries

> **Convention:** Architecture and implementation specs for all layers (kernel, shell, apps) live together under `specs/` rather than co-located with source code. This makes it easy to mount the entire `specs/` folder as agent context in a single operation.

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/architecture/` | System structure | Unix layers (Kernel/Shell/Apps), hexagonal layout, data flow, OS layer guide (`os.md`). Subdirs: `kernel/` (orchestrator, scheduler, browser), `shell/` (CLI). App-specific architecture lives under `apps/{app}/specs/`. See `specs/architecture/README.md` for index. MUST NOT dictate specific implementation patterns. |
| `specs/principles.md` | Design invariants | Design principles, architectural invariants, crate ownership rules, Effect-TS invariants, testing invariants, git workflow. The "constitution" — rules that MUST NOT be violated. |
| `specs/architecture/domain-model.md` | Types & schemas | Domain types, traits, storage schema (all SQL DDL), Effect-TS schemas, entity relationships. The "data dictionary." |
| `specs/gctl/` | gctl's own workflow | gctl's PRD and WORKFLOW files. See "gctl Kernel Workflow" section below. |

### Kernel Architecture — Orchestration & Dispatch

Kernel-level orchestration and the WORKFLOW.md file format are architecture specs, not application-level concerns. They MUST NOT be customized by applications.

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/architecture/kernel/orchestrator.md` | Orchestration state machine | Kernel-level dispatch, retry, reconciliation, agent-agnostic execution. Claim states, transition triggers, concurrency control, workspace management. |
| `specs/architecture/kernel/workflow-format.md` | WORKFLOW.md file format | YAML frontmatter + prompt template file format for agent dispatch. |

### Application Workflows (`apps/gctl-board/specs/workflows/`)

Opinionated product workflows owned by gctl-board. These define how work flows through the application — kanban lifecycle, sprint cycle, PR conventions, PRD format.

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `apps/gctl-board/specs/workflows/product-cycle.md` | Sprint cycle | Plan → iterate (agent-autonomous) → show & tell. Multiple iterations per cycle. Agent self-verification, autonomous fixes, suggestions. |
| `apps/gctl-board/specs/workflows/issue-lifecycle.md` | Kanban lifecycle | Statuses, transition rules, auto-transitions. |
| `apps/gctl-board/specs/workflows/pr-review.md` | PR review conventions | PR structure, review checklist, agent PR conventions, merge strategy. |
| `apps/gctl-board/specs/workflows/prd-template.md` | PRD template | Product requirements document template for gctl-board projects. |
| `apps/gctl-board/specs/workflows/roadmap-template.md` | Roadmap template | Milestones, task breakdown, acceptance criteria, open questions — decoupled from the PRD. |

### Application Specs (`apps/{app-name}/`)

Every application MUST have its own directory under `apps/` containing at minimum:

| File | Required | Content |
|------|----------|---------|
| `PRD.md` | MUST | Product requirements — problem, goals, use cases, roadmap. Instantiates the [PRD template](apps/gctl-board/specs/workflows/prd-template.md). |
| `WORKFLOW.md` | MUST | How work flows through the app — agent dispatch, personas, review conventions. |
| `specs/` | SHOULD | App-specific architecture, domain model, and implementation specs. |

```
apps/
├── gctl-board/           # First application
│   ├── PRD.md            # Board-specific product requirements
│   ├── WORKFLOW.md       # Board-specific workflow (agent assignment, issue lifecycle)
│   └── specs/            # Board-specific specs (tracker, kanban, dependencies)
├── observe-eval/         # Future application
│   ├── PRD.md
│   └── WORKFLOW.md
└── capacity/             # Future application
    ├── PRD.md
    └── WORKFLOW.md
```

This separates each app's product context from the kernel specs. Agents working on a specific app load that app's `PRD.md` and `WORKFLOW.md` for context — not the entire `specs/` tree.

### gctl Kernel Workflow (Dogfooding)

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/gctl/WORKFLOW.md` | gctl kernel's active workflow | gctl's instantiation of the templates above: project keys, agent config, PR conventions. This is the live dogfooding doc for kernel development. |
| `specs/gctl/PRD.md` | gctl kernel PRD | Product requirements for the kernel + shell (not applications). |

### Implementation Details

Detailed programming patterns, code examples, and how-to guides live under `specs/implementation/`, organized by layer. These MAY change frequently as the codebase evolves.

| Directory / File | Scope | Content that belongs here |
|-----------------|-------|--------------------------|
| `specs/implementation/kernel/` | Kernel implementation | Rust crate map, dependency graph, subsystem details (OTel, guardrails, context, proxy, sync, net, scheduler), kernel style guide, orchestrator, tracker. |
| `specs/implementation/shell/` | Shell implementation | Effect-TS CLI (`@effect/cli`), KernelClient/GitHubClient adapters, kernel↔shell HTTP communication patterns. |
| `specs/implementation/apps/` | Application implementation | Effect-TS package structure, gctl-board details, app style guide, integration modes (sidecar, embedded). |
| `specs/implementation/formal/` | Formal spec conventions | Lean 4 style: Mathlib, generic theorems, state machine file structure, proof style, naming conventions. |
| `specs/implementation/repo.md` | Monorepo structure | Nx + Cargo workspace setup, directory layout, cross-language orchestration. |
| `specs/implementation/kernel/orchestrator.md` | Orchestration implementation | gctl-orch Rust crate, agent adapters, retry constants, conformance testing. |

### Team

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/team/personas.md` | Agent personas | 7 specialist roles agents impersonate (Engineer, PM, UX, QA, DevSecOps, Security, Tech Lead). Prompt prefixes, review focus, multi-persona review rules. |

### Other

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/architecture/kernel/browser.md` | Browser control | CDP daemon spec, ref system, tab management. |
| `Request.md` | Deferred work | Gaps and open items by phase. |

## Invariants

> Quick reference. Canonical rules with full context live in `specs/principles.md`.

1. Dependencies MUST flow inward: Shell → Kernel → Domain, never reverse.
2. DuckDB is single-writer: the daemon MUST hold the lock; shell and apps MUST use the HTTP API.
3. Application tables MUST use namespaced prefixes (`board_*`, `eval_*`, `capacity_*`).
4. Code MUST NOT access Effect-TS `._tag` directly — use combinators (`Effect.catchTag`, `Match.tag`).
5. Every new public function MUST have at least one test.
6. Contributors MUST use feature branches — MUST NOT push directly to main.
7. All changes to main MUST go through a pull request — MUST NOT merge with `--admin` bypass.
8. MUST NOT rebase main — use merge commits only. MUST NOT force-push to main.
9. The Kernel MUST NOT make assumptions about applications.
10. Shell (Effect-TS CLI) MUST mediate all user-facing access to the kernel via HTTP API.
11. External tools (GitHub, Slack, AWS) MUST be accessed from the shell via `ccli` adapters — never from the kernel.
12. Every application MUST have its own `apps/{app-name}/` directory with `PRD.md` and `WORKFLOW.md`.

## Quick Reference

```sh
# Kernel (Rust)
cd kernel && cargo build             # Build all kernel crates
cd kernel && cargo test              # Tests across kernel crates
cd kernel && cargo run -- serve      # Start daemon on :4318

# Shell (Effect-TS CLI)
cd shell/gctl-shell
pnpm install && pnpm run build       # Build CLI
pnpm run test                        # Shell tests

# Applications (Effect-TS)
cd apps/gctl-board
pnpm install && pnpm run test        # Board tests (schema + services)
```

## Local Documentation

Before researching on the internet, check `specs/` and crawled documentation:
- `<domain>/DOMAIN_CONTEXT_INDEX.md` for available external docs
- Always use mermaid for architecture diagrams

## Documentation Standards

1. **Numbered lists for all rules.** All lists of principles, constraints, invariants, conventions, and rules in `specs/` documents MUST be numbered (1, 2, 3…), not bulleted. This enables precise cross-referencing (e.g., "see Invariant #3") and makes it clear when items are added or removed.

2. **Raw Markdown only.** All `specs/` documents MUST use standard CommonMark / GitHub-Flavored Markdown. Obsidian-specific syntax (wikilinks `[[...]]`, callouts `> [!note]`, empty-text links `[](url)`, block references `^block-id`) MUST NOT be used. Files MUST render correctly in any Markdown viewer.

3. **Mermaid diagrams only — no ASCII art.** All diagrams in `specs/` documents MUST use Mermaid (```` ```mermaid ````). ASCII box-drawing diagrams (using `┌─┐│└`, `+--+|`, or similar characters) MUST NOT be used. Use Mermaid `flowchart` for component and flow diagrams, `sequenceDiagram` for sequence diagrams, and `graph` for dependency/data-flow diagrams. This ensures diagrams render in Obsidian, GitHub, and any Markdown viewer with Mermaid support.

4. **Instructive language (RFC 2119).** All `specs/` documents MUST use instructive RFC 2119 keywords:
   - **MUST** / **MUST NOT** — absolute requirement or prohibition
   - **SHOULD** / **SHOULD NOT** — recommended, with documented exceptions
   - **MAY** — truly optional

   Prefer direct imperatives ("Store timestamps as RFC3339 VARCHAR") over descriptive statements ("Timestamps are stored as RFC3339 VARCHAR").

## Writing Specs

Specs MUST be concise and verifiable. Working code and references to real examples are preferred over lengthy prose that drifts from reality.

1. **Code over prose.** When specifying an interface, type, or behavior, include the actual Rust trait, Effect-TS schema, SQL DDL, or Lean 4 definition. A 10-line code block is more precise than a paragraph of description. If the code exists in the codebase, reference the file path instead of duplicating it. **For state machines and transition rules, the architecture specs are the source of truth** — markdown files MUST reference them rather than duplicating transition diagrams.

2. **Reference real examples.** When describing a pattern (e.g., "how to add a CLI command"), point to an existing file that demonstrates it (e.g., "see `kernel/crates/gctl-cli/src/commands/sessions.rs`"). A working example is the most trustworthy spec.

3. **Keep it short.** Each spec file SHOULD have a one-sentence summary at the top. Sections SHOULD be scannable — tables and code blocks over walls of text. If a section exceeds ~50 lines of prose, it probably needs to be split or replaced with code.

4. **Verifiable claims only.** Every MUST/SHOULD statement in a spec SHOULD be checkable — either by reading the code, running a test, or running `gctl spec audit`. Avoid vague requirements ("handle errors appropriately") that cannot be verified.

5. **Specs track the code.** When the code changes, the spec MUST be updated in the same PR. Stale specs are worse than no specs — they mislead. If a spec section is no longer accurate, delete it rather than leaving it to drift.

6. **One fact, one place.** Each concept (type definition, transition rule, table schema) MUST live in exactly one spec file. Other files MUST cross-reference it, not duplicate it. See the Specs Table of Contents above for where each kind of content belongs.

7. **Deferred is fine, vague is not.** If a design decision is not yet made, mark it explicitly as `[deferred]` with a brief note on what needs to be decided. Do not paper over uncertainty with ambiguous language.
