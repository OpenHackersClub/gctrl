# Uebermensch

> Chief-of-Staff app for investors. Vault-first, Obsidian-mountable, R2-synced.

See [PRD.md](PRD.md) for vision, [ROADMAP.md](ROADMAP.md) for milestones, [WORKFLOW.md](WORKFLOW.md) for lifecycle, and `specs/` for architecture details.

## Status

**MVP seed only.** No runtime code yet. This directory currently contains:

| Artifact | Status |
|----------|--------|
| `PRD.md`, `ROADMAP.md`, `WORKFLOW.md` | Complete |
| `specs/` (architecture, domain-model, profile, briefing-pipeline, knowledge-base, delivery, eval, telemetry) | Complete |
| `vault.sample/` | Seeded with Iran–Israel 2026 escalation as the first investigation topic |
| `src/` (Effect-TS app code) | Not started — M0 entry point |
| Kernel `uber_*` tables + routes | Not started — M0 storage task |
| `gctrl uber *` CLI surface | Not started — M0 |

## Seed topic: Iran–Israel 2026 escalation

The sample vault is pre-populated with one worked example so you can see the intended page-type shape before any code runs:

- **Thesis** — [`theses/iran-israel-escalation-2026.md`](vault.sample/theses/iran-israel-escalation-2026.md) — "Ceasefire tactical, nuclear-ambiguity phase beginning". Stance: watch, conviction: medium.
- **Topics** (macro) — `wiki/topics/macro/{iran-israel-escalation, iran-nuclear-program, strait-of-hormuz}.md`.
- **Entities** — orgs (Iran, Israel, IAEA, Hezbollah, Houthis, Natanz, Fordow), people (Ali Khamenei, Donald Trump, Benjamin Netanyahu).
- **Sources** — 3 primary (Wikipedia, Arms Control Association, Belfer Center).
- **Brief** — [`briefs/2026-04-18.md`](vault.sample/briefs/2026-04-18.md) — demonstrates the 5-item brief shape with bare `[[slug]]` citations.

Every citation in the sample is a bare `[[slug]]` wikilink (no typed prefixes) and resolves to a file's stem anywhere under the vault — this is the invariant the renderer will enforce.

## View in Obsidian

```sh
open -a "Obsidian.app" apps/uebermensch/vault.sample
```

Or "Open folder as vault…" from Obsidian's vault switcher. The graph view groups pages by `page_type` frontmatter.

## MVP path (next)

The smallest useful vertical slice, per [ROADMAP.md § M0](ROADMAP.md#m0-foundations--planned):

1. **Profile reader** — `apps/uebermensch/src/services/profile-service.ts` reading `$UBER_VAULT_DIR`'s authored tier with Schema validation.
2. **`gctrl uber vault init --from-sample`** — copies `vault.sample/` → `$UBER_VAULT_DIR` and renames `gitignore.template` → `.gitignore`.
3. **`gctrl uber profile validate`** — round-trip parse + report.
4. **Kernel vault mount** — `gctrl-kb` configured with `context_root = $UBER_VAULT_DIR, wiki_subpath = "wiki"` so the kernel reads/writes wiki pages at the vault root.
5. **Storage migration** — `uber_briefs` (with `vault_path` + `content_hash`), `uber_brief_items`, `uber_deliveries`, `uber_alerts` SQLite tables.
6. **driver-llm stub** — fixture adapter so `gctrl uber brief` is end-to-end runnable without a real LLM.
7. **`gctrl uber brief`** — reads 24h of wiki pages, calls stub LLM, writes `briefs/<date>.md` atomically.

**Done when** `gctrl uber brief` writes a valid brief against the sample vault and inserts an `uber_briefs` row with `vault_path` + `content_hash`.

## Directory layout

```
apps/uebermensch/
├── PRD.md                  # Problem, goals, principles
├── ROADMAP.md              # M0–M4 milestones
├── WORKFLOW.md             # Brief lifecycle state machine
├── README.md               # (this file)
├── specs/                  # Architecture, domain model, pipeline, KB, delivery, eval
└── vault.sample/           # Seeded vault — Iran–Israel 2026 topic
    ├── profile.md
    ├── topics.md
    ├── sources.md
    ├── ME.md / projects.md / avoid.md
    ├── README.md
    ├── gitignore.template  # → .gitignore on vault init
    ├── theses/
    ├── wiki/
    │   ├── topics/macro/
    │   ├── entities/orgs/
    │   ├── entities/people/
    │   └── sources/
    └── briefs/
```

## Related specs

- [specs/architecture.md](specs/architecture.md) — L0/L1 diagram, hexagonal layers
- [specs/profile.md](specs/profile.md) — vault layout, identity, R2 sync protocol
- [specs/briefing-pipeline.md](specs/briefing-pipeline.md) — curator → renderer → deliverer
- [specs/knowledge-base.md](specs/knowledge-base.md) — page types, frontmatter, lint rules
- [specs/domain-model.md](specs/domain-model.md) — Effect-TS schemas + SQLite DDL
