---
title: App Install Protocol — `gctrl-app.toml`, capability binding
status: spec
related:
  - vault/specs/architecture/app-decoupling.md
  - vault/specs/architecture/os.md § 3 Applications
  - vault/specs/architecture/kernel/sync.md § 2.4 App Vault Sync
---

# App Install Protocol

This spec defines how a gctrl app declares its capability requirements and how the kernel binds those requirements to its default kernel implementations at install time.

It is the load-bearing piece for the [zero-duplication invariant](app-decoupling.md): apps describe what they need, the kernel registry pins how to fulfill it, and `gctrl app install` is the operational point where requirements meet implementations.

> **Scope:** This protocol governs installation **on a gctrl host**. Operators running on a non-gctrl host fork the app and edit its default Layer wiring to call whatever the host provides — see [app-decoupling.md § Ejection](app-decoupling.md#ejection--what-actually-changes). v1 does not ship a runtime override / extension mechanism; the manifest is purely a declaration that the kernel installer consumes.

## Concepts

| Concept | Definition |
|---|---|
| **Manifest** | `gctrl-app.toml` at the app's package root. Declares the app's identity, the **capability requirements** it has, the **vault project key(s)** it owns under the shared external vault root, and the **scheduler hooks** it registers. |
| **Capability** | A named kernel-provided service (`llm`, `deliverer.telegram`, `vault.write`, `vault.sync`, `secrets`, `scheduler`, `otel.capture`, `search.brave`, `gcal`, `browser.cdp`, …). The kernel publishes the registry of capability ids it knows how to fulfill. |
| **Capability requirement** | An entry in `[requires]` declaring the app needs a capability. Optional capabilities go in `[optional]` — the app starts without them and feature-gates the relevant code paths. |
| **Capability binding** | The concrete kernel driver that fulfills a capability on this host. The capability registry pins a single default driver per capability id; install just records that the app is using it. |
| **Install** | `gctrl app install <ref>`. Reads the manifest, validates required capabilities are in the kernel registry, registers project keys under the kernel's vault root, registers scheduler hooks, persists the install record. |

## Manifest schema (`gctrl-app.toml`)

```toml
# gctrl-app.toml — placed at the app package root (apps/<name>/)

[app]
name = "uebermensch"                  # kebab-case, must match package name
version = "0.2.0"                     # semver
description = "Personal Chief of Staff for investors."
homepage = "https://github.com/OpenHackersClub/uebermensch"
license = "MIT"

# How to launch the app's CLI. The kernel resolves this at install time.
# `bin` is shipped by the package; `command` is what the kernel registers.
[entrypoint]
bin = "dist/main.js"                  # relative to package root
command = "uber"                      # `gctrl uber ...` invokes this
runtime = "node"                      # node | bun | deno | binary

# Capabilities the app cannot start without. Each entry names a kernel
# capability id from the registry; the kernel resolves the registered
# default driver automatically.
[requires.llm]
description = "Curator + summary lanes for brief / report / sinkin"

[requires.deliverer.telegram]
[requires.deliverer.discord]
[requires.vault.write]
[requires.vault.sync]
[requires.secrets]

# Optional capabilities. The kernel reports unavailable optional caps as
# install warnings; the app's code MUST feature-gate around missing ones
# (e.g. `uber timebox apply` fails closed when `gcal` is unavailable).
[optional.gcal]
description = "Google Calendar event apply for timeboxes"

[optional.search.brave]
description = "Brave Search API for ingest discovery"

[optional.browser.cdp]
description = "Headless Chromium for paywalled article extraction"

# Vault project keys this app owns. The vault ROOT is owned by the kernel
# (resolved from `--board-dir` → `GCTRL_BOARD_DIR` env → `./gctrl/`); each
# subdirectory of the root is a project key. The app declares which keys
# it claims at install time. Registered in `gctrl_vault_mounts` so the
# kernel watcher knows which app owns each key. See PR #163 for the
# externalized-vault model that this builds on.
[[vault-projects]]
key = "UBER"                           # uppercase; matches subdir under vault root
description = "Uebermensch namespace — directives / input / output / action subtrees"

# Scheduler hooks. Registered as kernel `schedules` rows at install time.
# The kernel scheduler runs them; the app does not own a scheduler.
[[schedule]]
name = "uber-daily-brief"
cron = "0 8 * * *"
target = "exec"
command = ["uber", "run-daily"]

[[schedule]]
name = "uber-weekly-report"
cron = "0 9 * * 1"
target = "exec"
command = ["uber", "report", "--send"]

# Secrets the app reads. The kernel's `driver-secrets` is the only
# component allowed to materialize values — the app calls `SecretsService.get`
# and never reads `process.env` directly. `kind = "string" | "url" | "token"`
# is a hint for the onboarding wizard's UX.
[[secrets]]
key = "ANTHROPIC_API_KEY"
kind = "token"
required = false                       # only required if [requires.llm] uses Anthropic
description = "Anthropic API key for LLM curator + summary lanes"

[[secrets]]
key = "TELEGRAM_BOT_TOKEN"
kind = "token"
required = false                       # only required if [requires.deliverer.telegram] is bound
description = "Telegram Bot API token"

[[secrets]]
key = "UBER_PUBLIC_BASE_URL"
kind = "url"
required = false
description = "Base URL where the synced vault is hosted (Cloudflare Pages, Tailscale Serve, …)"
```

### Schema rules

- All names are kebab-case. `[requires.<dot.path>]` and `[optional.<dot.path>]` use dotted capability identifiers.
- Capability identifiers MUST come from the published kernel capability registry (see [§ Capability Registry](#capability-registry)). Manifests referencing unknown capabilities are rejected at install. New capabilities require a kernel update.
- A capability listed in both `[requires]` and `[optional]` is an error.
- Project keys (`[[vault-projects]] key`) are uppercase, globally unique within a single vault root, and become subdirectory names directly. The kernel rejects install if the key collides with an already-registered project owned by a different app.
- The vault root is **kernel-owned**, not per-app. It comes from `--board-dir` → `GCTRL_BOARD_DIR` → `./gctrl/` (per [#163](https://github.com/OpenHackersClub/gctrl/pull/163)). Apps DO NOT declare a vault `root` in the manifest.

## Install flow

```mermaid
sequenceDiagram
  participant U as User
  participant K as gctrl kernel
  participant App as App package
  participant DB as DuckDB / SQLite

  U->>K: gctrl app install <ref>
  K->>App: read gctrl-app.toml
  K->>K: validate manifest (schema + every cap exists in registry)
  alt Required cap missing from registry
    K-->>U: error "uebermensch requires unknown capability `vault.frobnicate`"
  else Project key collides with another app
    K-->>U: error "project key `UBER` already owned by app `<other>`"
  else All checks pass
    K->>DB: register vault projects (gctrl_vault_mounts, owner=<app name>)
    K->>DB: register schedules (schedules)
    K->>DB: persist install record (gctrl_app_installs)
    K->>DB: persist resolved bindings (gctrl_app_bindings)
    K->>U: ✓ installed; report any unavailable optional caps as warnings
  end
```

### Concrete commands

| Command | What it does |
|---|---|
| `gctrl app install <ref>` | `<ref>` = local path or git URL. Reads manifest, validates capabilities, registers project keys + schedules + bindings. |
| `gctrl app status <name>` | Shows resolved bindings + last-checked status. |
| `gctrl app reload <name>` | Re-reads the manifest (after a version bump); re-validates capabilities; reconciles project keys / schedules / bindings. |
| `gctrl app uninstall <name>` | Removes the app's project-key registrations (files in the vault root NOT deleted), schedules, install record, bindings. |

There is no `--override` / `--disable` flag in v1. Bindings come exclusively from the capability registry. To run with different fulfillments, fork the app — see [Non-gctrl hosts](#non-gctrl-hosts) below.

## Capability registry

The kernel ships a registry of capabilities it knows how to fulfill. Each entry pins:

- The **port** an app's code references (`LlmService`, `DelivererService`, `VaultWriterPort`, …).
- The **default kernel driver** that fulfills it.
- The **HTTP route(s)** through which the app reaches the kernel implementation.
- The **wire format** the app and kernel agree on (request/response Schema).

```rust
// kernel/crates/gctrl-core/src/capabilities.rs (new)
pub struct CapabilityRegistration {
    pub id: &'static str,                 // e.g. "llm"
    pub default_driver: &'static str,     // e.g. "driver-llm"
    pub route_prefix: &'static str,       // e.g. "/api/llm"
    pub schema_module: &'static str,      // e.g. "gctrl_core::wire::llm"
}

pub const REGISTRY: &[CapabilityRegistration] = &[
    CapabilityRegistration {
        id: "llm",
        default_driver: "driver-llm",
        route_prefix: "/api/llm",
        schema_module: "gctrl_core::wire::llm",
    },
    CapabilityRegistration {
        id: "deliverer.telegram",
        default_driver: "driver-telegram",
        route_prefix: "/api/telegram",
        schema_module: "gctrl_core::wire::deliverer",
    },
    // …
];
```

Apps reference capability *ids*, not driver names. The kernel can swap out the default driver (e.g. `driver-llm` → `driver-llm-v2`) without every manifest needing an edit — the contract is the capability, not the implementation.

### Storage

```sql
-- kernel SQLite — single row per installed app
CREATE TABLE gctrl_app_installs (
  name           TEXT PRIMARY KEY,         -- matches manifest [app] name
  version        TEXT NOT NULL,
  source_ref     TEXT NOT NULL,            -- local path or git URL
  manifest_sha   TEXT NOT NULL,            -- sha256 of gctrl-app.toml
  installed_at   TEXT NOT NULL,
  reloaded_at    TEXT
);

-- one row per (install, capability) — records what the app uses
CREATE TABLE gctrl_app_bindings (
  install_name   TEXT NOT NULL REFERENCES gctrl_app_installs(name),
  capability     TEXT NOT NULL,            -- e.g. "llm"
  driver_id      TEXT NOT NULL,            -- registry's default driver, e.g. "driver-llm"
  required       INTEGER NOT NULL,         -- 1 if from [requires], 0 if [optional]
  resolved_at    TEXT NOT NULL,
  PRIMARY KEY (install_name, capability)
);
```

Both tables are kernel-infra (the `gctrl_*` prefix tracks *which apps are installed*, not per-app data).

The bindings table is essentially a denormalized join of `gctrl_app_installs` × the capability registry — kept materialized so `gctrl app status <name>` is a single-row read and so future schema changes (per-binding health, last-checked timestamp, …) have a place to land.

## Non-gctrl hosts

This protocol governs installation on a gctrl host. v1 does **not** ship a runtime override or extension mechanism — there is no `--override` flag, no `module:` Layer loader, no kernel CLI for swapping drivers per install.

When an operator wants to run uebermensch on a host without the gctrl kernel, the path is:

1. **Fork** the app (e.g. `OpenHackersClub/uebermensch` after the carve).
2. **Edit the default Layer** — the small TS file that wires `LlmService` / `DelivererService` / `VaultWriterPort` etc. to the host's available implementations (vendor SDKs, in-process modules, opinionated CLIs).
3. The app's business logic, ports, vault, and `gctrl-app.toml` manifest stay unchanged.

This is the rebinding-not-rewriting model from [app-decoupling.md § Ejection](app-decoupling.md#ejection--what-actually-changes), implemented at the *source-tree* level rather than at install-time. The manifest serves as the contract: it tells a forking operator (or the LLM helping them) exactly which capabilities they need to fulfill in the replacement Layer.

The manifest is therefore **a self-documenting capability requirements document** even off-gctrl — it just isn't *consumed by an installer* in that mode.

## Versioning + reload

- The manifest carries `version`. On `gctrl app reload`, the kernel re-reads the file, re-validates capabilities against the registry, and reconciles project keys / schedules / bindings.
- Schedules are reconciled by `name` — re-running `reload` is idempotent.
- Vault project keys are append-only by `key` — removing a `[[vault-projects]]` entry from the manifest does NOT delete the subdirectory under the kernel's vault root (operator-owned data; explicit `--prune-projects` flag for the destructive case).
- New required capabilities introduced by a manifest version bump fail the install if the kernel registry doesn't know them — operator must upgrade the kernel first.

## What apps look like at runtime

Apps continue to define ports (`LlmService`, `DelivererService`, `VaultWriterPort`, …) in their TypeScript / Rust source. The default Layer wires those ports to the *kernel HTTP routes* the capability registry pins (`/api/llm/*`, `/api/telegram/send`, `/api/vault/*`, `/api/sync/vault/*`, …).

The `gctrl-app.toml` manifest is the **declarative** description of what the app needs. The runtime Layer wiring is the **operational** consequence. They're two views of the same contract — one for the kernel installer, one for the app's code.

## What is explicitly out of scope (v1)

- **Runtime override / extension mechanism.** No `--override`, no `--disable`, no module-loaded Layers, no per-install driver swaps. Everything binds to its registered default. v2 may introduce a narrowly-scoped override mechanism if a real need surfaces.
- **App marketplace / registry.** `gctrl app install <ref>` only takes a local path or git URL.
- **Sandbox enforcement.** Bindings are advisory; the app *could* still call `process.env` directly, but linting + reviewer checks (per app-decoupling.md § Boundary Tests) catch that.
- **Multi-tenancy.** One install per app name per kernel. Running two parallel uebermensch installs is not supported.
- **Hot reload without restart.** `gctrl app reload` requires the app process to restart to pick up new bindings.

## Migration path for uebermensch

1. **Land this spec.** No code changes yet.
2. **Add `gctrl-app.toml`** to `apps/uebermensch/` describing what the app needs today (LLM, deliverers, vault.write, vault.sync, secrets, optional gcal, optional brave search, optional browser.cdp). Vault declaration: `[[vault-projects]] key = "UBER"` — no per-app `root`.
3. **Migrate uebermensch's vault into the kernel's shared root** (per [#163](https://github.com/OpenHackersClub/gctrl/pull/163)). The kernel's `--board-dir` / `GCTRL_BOARD_DIR` already names the root; uebermensch's content moves from `$UBER_VAULT_DIR/` to `${GCTRL_BOARD_DIR}/UBER/`. The legacy `UBER_VAULT_DIR` env var is removed once the watcher is generalized to every `gctrl_vault_mounts` row.
4. **Build the kernel-side install machinery**: `/api/app/install`, `/api/app/status`, `gctrl_app_installs` + `gctrl_app_bindings` tables, capability registry, project-key collision check against `gctrl_vault_mounts`.
5. **Replace `lib/mode.ts` + `--mode` flag** with: read the install record at startup; build the runtime Layer from the resolved bindings. The `Mode` enum becomes legacy / deleted.
6. **Document the fork-to-eject path** in uebermensch's README so an operator on a non-gctrl host can swap the default Layer for a host-specific one.

## Why this is the right shape

It encodes the spec correction: apps declare *what they need*; the kernel registry pins *how to fulfill it on a gctrl host*. Defaults make the gctrl-host happy path zero-effort. The manifest doubles as the spec a forking operator (or LLM) reads to write a replacement Layer for a non-gctrl host — *"It's user role to use LLM to configure the app to use opinionated driver or clis, or ignore particular feature set."* The configuration happens in the app's source tree at fork time, not at install time inside the kernel.
