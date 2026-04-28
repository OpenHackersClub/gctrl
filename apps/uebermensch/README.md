# Uebermensch

> Chief-of-Staff app for investors. Vault-first, Obsidian-mountable, R2-synced.

See [PRD.md](PRD.md) for vision, [ROADMAP.md](ROADMAP.md) for milestones, [WORKFLOW.md](WORKFLOW.md) for lifecycle, and `vault/specs/` for architecture details.

## Status

**M0 slice landed — runnable CLI against an external vault.** Reads md+frontmatter
config, walks `wiki/` + `theses/`, and writes a stub brief to `briefs/<date>.md`.
The kernel HTTP integration (`uber_*` tables, `/api/uber/*` routes, real LLM
drivers) remains for a follow-up PR.

| Artifact | Status |
|----------|--------|
| `PRD.md`, `ROADMAP.md`, `WORKFLOW.md`, `vault/specs/` | Complete |
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
frontmatter so Obsidian reads it natively. Minimum recognised files:

| Path | Contents |
|------|----------|
| `profile.md` | identity, budgets, delivery cadence, channels (frontmatter) |
| `topics.md` | topics of interest (frontmatter) |
| `sources.md` | feeds / drivers / cadences (frontmatter) |
| `ME.md`, `projects.md`, `avoid.md` | free-form author notes |
| `theses/*.md` | one file per thesis |
| `wiki/**/*.md` | generated entity / topic / source pages (gitignored, R2-synced) |
| `briefs/<date>.md` | written by `uber brief` |

See [vault/specs/profile.md](vault/specs/profile.md) for the full schema and sync model.

## Directory layout

```
apps/uebermensch/
├── PRD.md                  # Problem, goals, principles
├── ROADMAP.md              # M0–M4 milestones
├── WORKFLOW.md             # Brief lifecycle state machine
├── README.md               # (this file)
├── src/                    # Effect-TS CLI + services + adapters
├── tests/                  # vitest + fixtures/vault
└── vault/specs/                  # Architecture, domain model, pipeline, KB, delivery, eval
```

## Related specs

- [vault/specs/architecture.md](vault/specs/architecture.md) — L0/L1 diagram, hexagonal layers
- [vault/specs/profile.md](vault/specs/profile.md) — vault layout, identity, R2 sync protocol
- [vault/specs/briefing-pipeline.md](vault/specs/briefing-pipeline.md) — curator → renderer → deliverer
- [vault/specs/knowledge-base.md](vault/specs/knowledge-base.md) — page types, frontmatter, lint rules
- [vault/specs/domain-model.md](vault/specs/domain-model.md) — Effect-TS schemas + SQLite DDL
