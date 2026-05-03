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
