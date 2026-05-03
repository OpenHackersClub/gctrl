# Uebermensch — moved to its own repo

The uebermensch app source carved out of this monorepo per [ROADMAP M8 Phase B](https://github.com/OpenHackersClub/uebermensch/blob/main/README.md).

| What | Where |
|---|---|
| Source code | [`OpenHackersClub/uebermensch`](https://github.com/OpenHackersClub/uebermensch) |
| Issues | [`OpenHackersClub/uebermensch/issues`](https://github.com/OpenHackersClub/uebermensch/issues) (transferred from this repo, label `app:uebermensch`) |
| Docs (PRD, ROADMAP, WORKFLOW, specs, issue mirror) | `$UBER_VAULT_DIR/` — the user's Obsidian-mountable vault |
| Capability manifest | [`OpenHackersClub/uebermensch/gctrl-app.toml`](https://github.com/OpenHackersClub/uebermensch/blob/main/gctrl-app.toml) |

## Installing onto this kernel

```sh
git clone git@github.com:OpenHackersClub/uebermensch.git ../uebermensch
gctrl app install ../uebermensch
```

The kernel reads `gctrl-app.toml`, materializes capability bindings, and registers schedules.

## Why the carve

Uebermensch is a vault-first app whose primary editor (the user, in Obsidian) is not the gctrl monorepo. Decoupling source from kernel lets:

- Non-developer spec edits flow through Obsidian without engaging the kernel repo
- Forks rebind capabilities for non-gctrl hosts by editing one Layer module
- Uebermensch ship its own release cadence

See [`vault/specs/architecture/app-decoupling.md`](../vault/specs/architecture/app-decoupling.md) for the full contract.
