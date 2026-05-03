# gctrl -- GroundCtrl

Local-first operating system for human+agent teams. Unix-inspired: **Kernel** (telemetry, storage, guardrails, network, browser, sync), **Shell** (CLI, HTTP API, query engine), **Applications & Utilities** (board, eval, capacity, net tools).

Follows conventions from `@debuggingfuture/arch-taste.md`.

See `AGENTS.md` for the full knowledge base index, invariants, and documentation standards. See `vault/specs/` for architecture, domain model, principles, and implementation details.

## Roadmap Lives in PRD.md / ROADMAP.md / WORKFLOW.md + Issues — Not in Memory or Other Spec Prose

Roadmap state (PR1, PR2, PR3 plans; milestone slicing; "what's left to ship") MUST live in the existing externalized vault files and GitHub issues, not in agent memory or in unrelated spec markdown:

- **`PRD.md`** — `vault/specs/gctrl/PRD.md` for the repo, `apps/{app}/vault/PRD.md` for each app (must live inside the app's vault). Problem, goals, non-goals, use cases, success criteria. Does not list PR sequencing.
- **`ROADMAP.md`** — `vault/specs/gctrl/ROADMAP.md` for the repo, `apps/{app}/vault/ROADMAP.md` for each app. **This is where milestone breakdowns and slice tables live** — one row per slice with priority, dependency, and an `Issue` column linking to the GitHub issue. PR1/PR2 sequencing belongs here, not in memory.
- **GitHub issues** — one per slice listed in `ROADMAP.md`. The issue carries discussion, sub-tasks, links to PRs. The roadmap row references the issue by number; the issue references back via the slice id.
- **`WORKFLOW.md`** — `vault/specs/gctrl/WORKFLOW.md` for the repo, `apps/{app}/vault/WORKFLOW.md` for each app. Governs how a slice flows from roadmap row → issue → branch → PR → merge → release. Follow it; do not invent ad-hoc per-area flows.

Agent memory and unrelated `*.md` specs MUST NOT enumerate "PR1 of 6 lands X, PR2 lands Y, ..." or carry milestone roadmaps inline. Other specs describe the **end state and design decisions**; the slice plan describing *how we get there* is `ROADMAP.md` + issues.

When you are tempted to write "PR3 will add ..." in a design spec, in a memory file, or in `MEMORY.md`: stop, add a row to the relevant `ROADMAP.md` instead, open (or link) the GitHub issue, and have the design spec reference the issue by number. When recalling state, read `ROADMAP.md` and `gctrl gh issues list` (or fall back to `gh issue list`) — do not rely on memory snapshots of PR sequencing, which go stale within days.

This applies retroactively: if you find PR-numbered enumerations in memory or in design-spec prose, prune them and replace with a pointer to the `ROADMAP.md` row / issue.

## Specs Default to the Vault, Not the Codebase

Project specs (PRD.md, ROADMAP.md, WORKFLOW.md, architecture, domain model, frontmatter / schema docs) default to **the app's vault**, not the source tree. This complements the rule above by clarifying *where* the app's vault lives.

**The app's vault is one of:**

- **In-tree** at `apps/<name>/vault/` — default for monorepo-resident apps with no dedicated user-edited operational data (gctrl-board, gctrl-net, future engineering-tool apps).
- **External** at `$<APP>_VAULT_DIR` — when the app already owns an Obsidian-mountable vault that the user lives in. **uebermensch is the precedent**: docs live at `$UBER_VAULT_DIR/{PRD,ROADMAP,WORKFLOW}.md` and `$UBER_VAULT_DIR/specs/`, not under `apps/uebermensch/vault/`. New apps with operational vault data (briefs, journals, theses, schedules) should externalize from the start.

Same convention, two valid locations. The `gctrl-app.toml` manifest declares which one via the `[[vault-projects]]` block (or by the app convention of reading `$<APP>_VAULT_DIR`).

**Why default to the vault:**

1. **Non-developers can edit specs.** PMs, the user, future-self update PRD/ROADMAP/WORKFLOW from Obsidian without learning `git checkout -b`. Lowering the bar to spec edits is the single biggest argument for vault-resident specs and matters more over time as the spec audience widens.
2. **Eject portability.** When an app carves out to its own repo, vault-resident specs don't move with the source — they stay where the user already reads them. Source forks become purely about code; spec evolution is decoupled from source-tree decisions.
3. **Cross-app graph.** Specs across apps in one Obsidian vault wikilink to each other; the user gets a knowledge graph of their projects, not N siloed `docs/` folders.
4. **Specs already describe vault content.** Frontmatter schemas, vault layout, brief / event / inbox templates — they describe what users edit; co-locating doc and described content is consistent.

**Exceptions — keep specs with code when:**

1. The spec is an **input to code generation** (OpenAPI, JSON Schema, protobuf). Atomic commits are required for reproducible builds.
2. The spec is a **contract that locks a code shape** the runtime depends on byte-for-byte (exact `Schema.Struct` field order, generated client surfaces). Drift is a bug.
3. The audience is **engineers exclusively** — internal ADRs, hot-path invariants, perf notes. No non-engineer ever reads them.

In doubt, lean vault. Spec drift in user-facing docs is more recoverable than the cost of locking out non-developer editors.

**Sharing a vault folder across agent worktrees is fine.** Multiple agent worktrees that all read/write the same `$UBER_VAULT_DIR/specs/` (or `apps/<name>/vault/`) is manageable in practice — specs are markdown that change rarely, conflicts are easy to spot in `git status`, and Obsidian's atomic-write convention handles concurrent saves. Don't over-engineer per-worktree spec sandboxing; treat the vault like a shared dev database — one source of truth, occasional coordination via standard git tools.
