# Uebermensch

> Chief-of-Staff app for investors. Vault-first, Obsidian-mountable, R2-synced.

## Where the docs live

The product, roadmap, architecture, and issue tracker are **not in this directory** — they ejected to the operational vault that `UBER_VAULT_DIR` points at, where they're editable in Obsidian alongside the brief / wiki / event data. See [`apps/uebermensch/ROADMAP.md` § M8](https://github.com/OpenHackersClub/gctrl/issues?q=is%3Aissue+label%3Aapp%3Auebermensch) for the eject plan.

| Doc | Path |
|---|---|
| PRD | `$UBER_VAULT_DIR/PRD.md` |
| Roadmap | `$UBER_VAULT_DIR/ROADMAP.md` |
| Workflow | `$UBER_VAULT_DIR/WORKFLOW.md` |
| Specs | `$UBER_VAULT_DIR/specs/` (architecture, domain-model, profile, knowledge-base, briefing-pipeline, delivery, eval, calendar, calendar-timeboxes, sinkin, scheduling, events) |
| Issues | `$UBER_VAULT_DIR/issues/UBER-<N>.md` (mirrored from GH `app:uebermensch` label) |

Default `$UBER_VAULT_DIR` for the maintainer: `/Users/debuggingfuture/workspaces/df/uebermensch-vault/` (own git repo, mounted in Obsidian).

## What stays here

This directory holds the **source code** until Phase B of the eject — at which point it carves out to `OpenHackersClub/uebermensch`. Currently:

```
apps/uebermensch/
├── gctrl-app.toml         # capability manifest — the install contract
├── src/                   # Effect-TS CLI + services + adapters
├── tests/                 # vitest + fixtures
├── personas/              # persona prompt templates
└── package.json   tsconfig.json   tsup.config.ts   vitest.config.ts
```

## Quickstart

```sh
pnpm install --filter uebermensch
pnpm --filter uebermensch build

# Set UBER_VAULT_DIR (defaults to ~/uebermensch-vault if unset by the kernel installer):
#   export UBER_VAULT_DIR=/Users/you/workspaces/your-uebermensch-vault

pnpm env:run node apps/uebermensch/dist/bin/uber.js profile validate
pnpm env:run node apps/uebermensch/dist/bin/uber.js brief
```

All capabilities (LLM, Telegram, Discord, vault sync, secrets) route through the gctrl kernel HTTP API — see [`gctrl-app.toml`](gctrl-app.toml) for the declared requirements and [`vault/specs/architecture/app-decoupling.md`](../../vault/specs/architecture/app-decoupling.md) for the zero-duplication contract.
