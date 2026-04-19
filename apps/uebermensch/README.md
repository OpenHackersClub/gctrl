# Uebermensch

> Chief-of-Staff app for investors. Vault-first, Obsidian-mountable, R2-synced.

See [PRD.md](PRD.md) for vision, [ROADMAP.md](ROADMAP.md) for milestones, [WORKFLOW.md](WORKFLOW.md) for lifecycle, and `specs/` for architecture details.

## Status

**M0 slice landed — runnable CLI against an external vault.** Reads md+frontmatter
config, walks `wiki/` + `theses/`, and writes a stub brief to `briefs/<date>.md`.
The kernel HTTP integration (`uber_*` tables, `/api/uber/*` routes, real LLM
drivers) remains for a follow-up PR.

| Artifact | Status |
|----------|--------|
| `PRD.md`, `ROADMAP.md`, `WORKFLOW.md`, `specs/` | Complete |
| `src/` — profile reader, vault reader, stub LLM, CLI | Shipped (this PR) |
| `uber profile validate` | Shipped |
| `uber vault init` | Shipped (scaffolds from `tests/fixtures/vault/`) |
| `uber brief` | Shipped — stub LLM by default, real Anthropic via `UBER_LLM_PROVIDER=anthropic` |
| Kernel `uber_*` tables + `/api/uber/*` routes | Deferred to M0 follow-up |
| Anthropic LLM adapter (`@anthropic-ai/sdk`, prompt caching on preamble) | Shipped (M1b) |

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

### LLM provider selection

`uber brief` reads `UBER_LLM_PROVIDER` (default `stub`). Supported values:

| Value | Behaviour | Required env |
|-------|-----------|--------------|
| `stub` | Deterministic extractive stub — emits top-N candidates as `[[slug]]` items. No network. | — |
| `anthropic` | Real curator via `@anthropic-ai/sdk`. System preamble is cached with `cache_control: ephemeral`. | `ANTHROPIC_API_KEY` |

Optional tuning for `anthropic`:

| Var | Default | Notes |
|-----|---------|-------|
| `UBER_LLM_MODEL` | `claude-sonnet-4-6` | Any model ID the account can call |
| `UBER_LLM_MAX_OUTPUT_TOKENS` | `4096` | Curator JSON is small; bump for long briefs |

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

See [specs/profile.md](specs/profile.md) for the full schema and sync model.

## Directory layout

```
apps/uebermensch/
├── PRD.md                  # Problem, goals, principles
├── ROADMAP.md              # M0–M4 milestones
├── WORKFLOW.md             # Brief lifecycle state machine
├── README.md               # (this file)
├── src/                    # Effect-TS CLI + services + adapters
├── tests/                  # vitest + fixtures/vault
└── specs/                  # Architecture, domain model, pipeline, KB, delivery, eval
```

## Related specs

- [specs/architecture.md](specs/architecture.md) — L0/L1 diagram, hexagonal layers
- [specs/profile.md](specs/profile.md) — vault layout, identity, R2 sync protocol
- [specs/briefing-pipeline.md](specs/briefing-pipeline.md) — curator → renderer → deliverer
- [specs/knowledge-base.md](specs/knowledge-base.md) — page types, frontmatter, lint rules
- [specs/domain-model.md](specs/domain-model.md) — Effect-TS schemas + SQLite DDL
