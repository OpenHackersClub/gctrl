# Uebermensch

> Chief-of-Staff app for investors. Vault-first, Obsidian-mountable, R2-synced.

See [vault/PRD.md](vault/PRD.md) for vision, [vault/ROADMAP.md](vault/ROADMAP.md) for milestones, [vault/WORKFLOW.md](vault/WORKFLOW.md) for lifecycle, and `vault/specs/` for architecture details.

## Status

**M0 slice landed — runnable CLI against an external vault.** Reads md+frontmatter
config from `directives/`, walks `input/wiki/` + `directives/theses/`, and writes a stub brief to `input/briefs/<date>.md`.
The kernel HTTP integration (`uber_*` tables, `/api/uber/*` routes, real LLM
drivers) remains for a follow-up PR.

| Artifact | Status |
|----------|--------|
| `vault/{PRD,ROADMAP,WORKFLOW}.md`, `vault/specs/` | Complete |
| `src/` — profile reader, vault reader, stub LLM, CLI | Shipped (this PR) |
| `uber profile validate` | Shipped |
| `uber vault init` | Shipped (scaffolds from `tests/fixtures/vault/`) |
| `uber brief` | Shipped (stub LLM → `briefs/<date>.md`) |
| Kernel `uber_*` tables + `/api/uber/*` routes | Deferred to M0 follow-up |
| Real LLM driver (local-first: LM Studio @ `127.0.0.1:1234`, default `google/gemma-4-31b`; Cloudflare AI Gateway opt-in via `GCTRL_LLM_PROVIDER=cloudflare`) | M1 |

## Quickstart

```sh
pnpm install --filter uebermensch
pnpm --filter uebermensch build

# Set UBER_VAULT_DIR in the repo-root .env (dotenvx convention):
#   UBER_VAULT_DIR=~/uebermensch-vault
# Or scaffold a fresh vault from the bundled fixture:
node apps/uebermensch/dist/bin/uber.js vault init ~/my-vault

# Run via dotenvx so env vars from .env (or .env.vault in CI) are injected:
pnpm env:run node apps/uebermensch/dist/bin/uber.js profile validate
pnpm env:run node apps/uebermensch/dist/bin/uber.js brief
```

Env vars are loaded from the repo-root `.env` (plaintext, gitignored) or
`.env.vault` (encrypted, committed) via `@dotenvx/dotenvx`. See the top-level
`.env.example` for the full template.

## Vault layout

The vault is markdown-first — every authored config file is CommonMark with YAML
frontmatter so Obsidian reads it natively. Four canonical root folders:

| Path | Contents |
|------|----------|
| `directives/profile.md` | identity, budgets, delivery cadence, channels (frontmatter) |
| `directives/topics.md` | topics of interest (frontmatter) |
| `directives/sources.md` | feeds / drivers / cadences (frontmatter) |
| `directives/me.md`, `directives/projects.md`, `directives/avoid.md` | free-form author notes |
| `directives/theses/*.md` | one file per thesis |
| `directives/prompts/*.md` | user-authored research queries |
| `input/raw/*.md` | driver-fetched + manually-pulled URL summaries |
| `input/briefs/<date>.md` | daily briefs written by `uber brief` |
| `input/reports/<slug>.md` | deep-dives and prompt-driven research answers |
| `input/wiki/**/*.md` | generated entity / topic / synthesis pages (gitignored, R2-synced) |
| `action/events/*.md` | authored personal events |
| `action/events/generated/*.md` | driver-pulled calendar events (gitignored, R2-synced) |

See [vault/specs/profile.md](vault/specs/profile.md) for the full schema and sync model.

## Directory layout

```
apps/uebermensch/
├── README.md               # (this file)
├── src/                    # Effect-TS CLI + services + adapters
├── tests/                  # vitest + fixtures/vault
└── vault/                  # Obsidian-mountable app vault
    ├── PRD.md              # Problem, goals, principles
    ├── ROADMAP.md          # M0–M4 milestones, slice rows, issue links
    ├── WORKFLOW.md         # Brief lifecycle state machine
    └── specs/              # Architecture, domain model, pipeline, KB, delivery, eval
```

> Per the workspace convention (see `AGENTS.md` § Application Specs), `PRD.md` / `ROADMAP.md` / `WORKFLOW.md` MUST live inside the app's vault — never at the app top level.

## Related specs

- [vault/specs/architecture.md](vault/specs/architecture.md) — L0/L1 diagram, hexagonal layers
- [vault/specs/profile.md](vault/specs/profile.md) — vault layout, identity, R2 sync protocol
- [vault/specs/briefing-pipeline.md](vault/specs/briefing-pipeline.md) — curator → renderer → deliverer
- [vault/specs/knowledge-base.md](vault/specs/knowledge-base.md) — page types, frontmatter, lint rules
- [vault/specs/domain-model.md](vault/specs/domain-model.md) — Effect-TS schemas + SQLite DDL
