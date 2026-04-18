# My Uebermensch vault

This directory is both a **git repo** and an **Obsidian vault**.

- Open this folder in Obsidian — the graph, wikilinks, and frontmatter just work.
- Edit anything under `theses/`, `topics.yaml`, `sources.yaml`, `ME.md`, `projects.md`, `avoid.md` — these are the authored tier the app reads.
- Don't hand-edit `wiki/` or `briefs/` — those are LLM-maintained and R2-synced. You may read and annotate in Obsidian; the app picks up your edits on the next tick.

Key files:

| File | Purpose |
|------|---------|
| `profile.yaml` | identity, budgets, delivery channels, brief cadence |
| `topics.yaml` | topics I care about + watchlists |
| `sources.yaml` | RSS / market / SEC / manual sources per topic |
| `theses/` | one markdown file per open thesis |
| `ME.md`, `projects.md`, `avoid.md` | free-form context fed to every persona |
| `wiki/` (generated) | entities, topics, sources, synthesis pages |
| `briefs/` (generated) | one markdown file per dated brief |

See [apps/uebermensch/specs/profile.md](../specs/profile.md) in the gctrl repo for full schema + sync details.
