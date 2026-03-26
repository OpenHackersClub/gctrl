# AGENTS.md

## Overview

GroundCtrl (gctl) is a local-first operating system for human+agent teams. Follows the **Unix layered model**: a **Kernel** (telemetry, storage, guardrails, network, browser, sync), a **Shell** (CLI gateway, HTTP API, query engine), **Native Applications & Utilities** (board, eval, capacity, net tools), and **External Applications** (Linear, Plane, Notion, Phoenix — connected via drivers). Rust daemon with DuckDB storage. Unix philosophy throughout; DDD for domain modeling.

**Dogfooding:** We use gctl to build gctl. gctl's own issue tracking, agent dispatch, and PR workflow are defined in `specs/gctl/workflows`, which instantiates the reusable workflow templates in `specs/gctl/workflows/`. The telemetry, task tracking, guardrails, and CLI tools are exercised daily during development. If a feature isn't useful for building gctl itself, question whether it belongs. Bugs found during dogfooding are the highest-priority fixes.

## Specs Table of Contents

The `specs/` directory is the single source of truth. Each file has a clear scope — put content in the right place.

### Product & Strategy

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/prd.md` | Product requirements | Goals, non-goals, high-level use cases, target audience, user stories, feature priorities. MUST NOT contain implementation details or code examples. |

### Architecture & Boundaries

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/architecture/` | System structure | Unix layers (Kernel/Shell/Apps), hexagonal layout, data flow, scheduler, OS layer guide (`os.md`), gctl-board. See `specs/architecture/README.md` for index. MUST NOT dictate specific implementation patterns. |
| `specs/principles.md` | Design invariants | Design principles, architectural invariants, crate ownership rules, Effect-TS invariants, testing invariants, git workflow. The "constitution" — rules that MUST NOT be violated. |
| `specs/architecture/domain-model.md` | Types & schemas | Domain types, traits, storage schema (all SQL DDL), Effect-TS schemas, entity relationships. The "data dictionary." |
| `specs/gctl/workflows` | gctl's own workflow | Instantiation of `specs/gctl/workflows/` templates for gctl itself. See "gctl's Own Workflow" section below. |

### Workflow Templates (`specs/gctl/workflows/`)

Reusable workflow templates for any application built on gctl. gctl dogfoods these by instantiating them in `specs/gctl/workflows` — gctl's own workflow is the first and primary consumer. Other applications adopt the same templates by referencing and instantiating them in their own workflow docs.

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/gctl/workflows/README.md` | Template index | Catalog of available workflow templates and how to use them. |
| `specs/gctl/workflows/product-cycle.md` | Sprint cycle template | Plan → iterate (agent-autonomous) → show & tell. Multiple iterations per cycle. Agent self-verification, autonomous fixes, suggestions. |
| `specs/gctl/workflows/issue-lifecycle.md` | Kanban template | Statuses, transition rules, auto-transitions. Adopted by `specs/gctl/workflows`. |
| `specs/gctl/workflows/task-planning.md` | Task planning template | Local decomposition, DAG dependencies, promotion to issues. |
| `specs/gctl/workflows/pr-review.md` | PR review template | PR structure, review checklist, agent PR conventions, merge strategy. |
| `specs/gctl/workflows/workflow-file.md` | WORKFLOW.md format | YAML frontmatter + prompt template file format for agent dispatch. |
| `specs/gctl/workflows/orchestration.md` | Orchestration state machine | Kernel-level dispatch, retry, reconciliation, agent-agnostic execution. Inspired by Symphony. |

### gctl's Own Workflow (Dogfooding)

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/gctl/workflows` | gctl's active workflow | gctl's instantiation of the templates above: project keys, agent config, tracker sync, PR conventions, end-to-end example. This is the live dogfooding doc — it MUST stay in sync with how gctl is actually developed. |

### Implementation Details

Detailed programming patterns, code examples, and how-to guides live under `specs/implementation/`. These MAY change frequently as the codebase evolves.

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/implementation/style-guide.md` | Coding patterns | Effect-TS patterns (tagged errors, services, layers, branded types), Rust patterns (clap, thiserror, trait objects), DuckDB conventions, table namespacing. Concrete code examples belong here. |
| `specs/implementation/testing.md` | Test strategy | Test pyramid, how to run tests, crate-specific test approaches, fixture patterns, integration test setup. |
| `specs/implementation/components.md` | Component details | Crate/package map, dependency graph, hexagonal wiring, runtime model (Rust + Effect-TS), scheduler adapters, kernel subsystem internals, gctl-net. Language/framework-specific details that architecture docs intentionally omit. |
| `specs/implementation/repo.md` | Monorepo structure | Nx + Cargo workspace setup, directory layout, dual build system, cross-language orchestration, caching, per-project config conventions. |
| `specs/implementation/orchestration.md` | Orchestration implementation | Lean 4 formal verification, gctl-orch Rust crate, agent adapters, retry constants, conformance testing. |
| `specs/implementation/skills.md` | Skills implementation | Skill catalog, conventions, `gctl spec` utility, audit rule interface, transitional pattern. |

### Decision Records & Plans

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/decisions/` | ADRs | Architecture Decision Records (numbered). One file per decision. |
| `specs/plans/` | Execution plans | Active and completed implementation plans. |

### Team

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/team/personas.md` | Agent personas | 7 specialist roles agents impersonate (Engineer, PM, UX, QA, DevSecOps, Security, Tech Lead). Prompt prefixes, review focus, multi-persona review rules. |

### Other

| Document | Scope | Content that belongs here |
|----------|-------|--------------------------|
| `specs/browser.md` | Browser control | CDP daemon spec, ref system, tab management. |
| `Request.md` | Deferred work | Gaps and open items by phase. |

## Invariants

> Quick reference. Canonical rules with full context live in `specs/principles.md`.

1. Dependencies MUST flow inward: Shell -> Kernel -> Domain, never reverse.
2. DuckDB is single-writer: the server MUST hold the lock; CLI MUST use `--db` or HTTP API.
3. Application tables MUST use namespaced prefixes (`board_*`, `eval_*`, `capacity_*`).
4. Code MUST NOT access Effect-TS `._tag` directly — use combinators (`Effect.catchTag`, `Match.tag`).
5. Every new public function MUST have at least one test.
6. Contributors MUST use feature branches — MUST NOT push directly to main.
7. The Kernel MUST NOT make assumptions about applications.
8. Shell MUST mediate all external access to the kernel.

## Quick Reference

```sh
cargo build                  # Build all crates
cargo test                   # 87 tests across 9 crates
cargo run -- serve           # OTel receiver on :4318
cargo run -- status          # Quick health check

cd packages/gctl-board
bun install && bun run test  # 6 Effect-TS schema tests
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

1. **Code over prose.** When specifying an interface, type, or behavior, include the actual Rust trait, Effect-TS schema, SQL DDL, or Lean 4 definition. A 10-line code block is more precise than a paragraph of description. If the code exists in the codebase, reference the file path instead of duplicating it.

2. **Reference real examples.** When describing a pattern (e.g., "how to add a CLI command"), point to an existing file that demonstrates it (e.g., "see `crates/gctl-cli/src/commands/sessions.rs`"). A working example is the most trustworthy spec.

3. **Keep it short.** Each spec file SHOULD have a one-sentence summary at the top. Sections SHOULD be scannable — tables and code blocks over walls of text. If a section exceeds ~50 lines of prose, it probably needs to be split or replaced with code.

4. **Verifiable claims only.** Every MUST/SHOULD statement in a spec SHOULD be checkable — either by reading the code, running a test, or running `gctl spec audit`. Avoid vague requirements ("handle errors appropriately") that cannot be verified.

5. **Specs track the code.** When the code changes, the spec MUST be updated in the same PR. Stale specs are worse than no specs — they mislead. If a spec section is no longer accurate, delete it rather than leaving it to drift.

6. **One fact, one place.** Each concept (type definition, transition rule, table schema) MUST live in exactly one spec file. Other files MUST cross-reference it, not duplicate it. See the Specs Table of Contents above for where each kind of content belongs.

7. **Deferred is fine, vague is not.** If a design decision is not yet made, mark it explicitly as `[deferred]` with a brief note on what needs to be decided. Do not paper over uncertainty with ambiguous language.
