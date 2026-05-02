---
title: App Install Protocol — `gctrl-app.toml`, capability binding, ejection
status: spec
related:
  - vault/specs/architecture/app-decoupling.md
  - vault/specs/architecture/os.md § 3 Applications
  - vault/specs/architecture/kernel/sync.md § 2.4 App Vault Sync
---

# App Install Protocol

This spec defines how a gctrl app declares its capability requirements, how the kernel binds those requirements to default kernel implementations at install time, and how a non-gctrl host (or an operator using opinionated CLIs) overrides those bindings — i.e. **ejection**.

It is the load-bearing piece for the [zero-duplication invariant](app-decoupling.md): apps describe what they need; the host decides how to fulfill it.

## Concepts

| Concept | Definition |
|---|---|
| **Manifest** | `gctrl-app.toml` at the app's package root. Declares the app's identity, the **capability requirements** it has, the **vault mounts** it owns, and the **scheduler hooks** it registers. |
| **Capability** | A named kernel-provided service (`llm`, `deliverer.telegram`, `vault.write`, `vault.sync`, `secrets`, `scheduler`, `otel.capture`, `search.brave`, `gcal`, `browser.cdp`, …). |
| **Capability requirement** | An entry in `[requires]` declaring the app needs a capability. Optional capabilities go in `[optional]` — the app starts without them and feature-gates the relevant code paths. |
| **Capability binding** | A concrete fulfillment: which kernel driver / CLI / user-supplied module satisfies the requirement on this host. |
| **Default binding** | The kernel-provided binding for a capability, supplied automatically when the app is installed on a gctrl host. |
| **Override binding** | A user-supplied alternative wired at install time (different driver, different CLI, custom Layer, or "disabled" to ignore the feature). |
| **Install** | `gctrl app install <ref>`. Reads the manifest, resolves bindings, validates the app can start with the available bindings, registers vault mounts, registers scheduler hooks. |

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
# capability; the kernel provides a default binding unless an `[overrides]`
# table overrides it at install time.
[requires.llm]
description = "Curator + summary lanes for brief / report / sinkin"
default-driver = "driver-llm"          # kernel-side fulfiller

[requires.deliverer.telegram]
default-driver = "driver-telegram"

[requires.deliverer.discord]
default-driver = "driver-discord"

[requires.vault.write]
default-driver = "kernel-vault-fs"     # kernel writes to local FS

[requires.vault.sync]
default-driver = "gctrl-sync.vault"    # kernel /api/sync/vault/* (sync.md § 2.4)

[requires.secrets]
default-driver = "driver-secrets"

# Optional capabilities. App MUST gracefully degrade when these are unbound.
# (e.g. `uber timebox apply` fails closed if `gcal` is unbound.)
[optional.gcal]
description = "Google Calendar event apply for timeboxes"
default-driver = "driver-gcal"

[optional.search.brave]
description = "Brave Search API for ingest discovery"
default-driver = "driver-brave"

[optional.browser.cdp]
description = "Headless Chromium for paywalled article extraction"
default-driver = "driver-browser"

# Vault mounts the app owns. Registered in `gctrl_vault_mounts` at install
# time; the kernel watcher indexes path changes thereafter.
[[vault-mounts]]
name = "uber"                          # unique; used as R2 prefix
root = "${UBER_VAULT_DIR:-~/uber-vault}"
description = "Uebermensch app vault — directives + input + output"

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
- Capability identifiers MUST come from a published kernel capability registry (see [§ Capability Registry](#capability-registry)). Custom capabilities require a kernel update.
- `default-driver` MUST name a kernel driver that exists. The kernel rejects install if not found.
- A capability listed in both `[requires]` and `[optional]` is an error.
- Vault mount names are globally unique within the kernel (one row per `gctrl_vault_mounts.name`).

## Install flow

```mermaid
sequenceDiagram
  participant U as User
  participant K as gctrl kernel
  participant App as App package
  participant FS as Local filesystem
  participant DB as DuckDB / SQLite

  U->>K: gctrl app install <ref> [--override <cap>=<binding>]
  K->>App: read gctrl-app.toml
  K->>K: validate manifest (schema + capability registry)
  K->>K: resolve bindings (defaults ∪ overrides)
  K->>K: dry-run start: every required cap has a binding?
  alt Missing required binding
    K-->>U: error "uebermensch requires `secrets`; no binding available"
  else All required bindings present
    K->>DB: register vault mounts (gctrl_vault_mounts)
    K->>DB: register schedules (schedules)
    K->>DB: persist install record (gctrl_app_installs)
    K->>U: ✓ installed; missing optional caps reported as warnings
  end
```

### Concrete commands

| Command | What it does |
|---|---|
| `gctrl app install <ref>` | `<ref>` = local path or git URL. Reads manifest, applies defaults, registers mounts + schedules. |
| `gctrl app install <ref> --override llm=local-claude-code-cli` | Replaces the default `llm` binding with a user-supplied one. |
| `gctrl app install <ref> --disable optional.gcal` | Explicit disable of an optional capability (skip wiring). |
| `gctrl app status <name>` | Shows current bindings, last-checked status of each. |
| `gctrl app reload <name>` | Re-reads the manifest (after a version bump); re-applies bindings. |
| `gctrl app uninstall <name>` | Removes vault mounts (mount registration only — files NOT deleted), schedules, install record. |

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

Apps reference capability *ids*, not driver names. Two reasons:

1. The kernel can swap out the default driver (e.g. `driver-llm` → `driver-llm-v2`) without every manifest needing an edit.
2. Override bindings target the capability id, not the driver — the contract is the port, not the implementation.

## Override bindings — the ejection seam

When `--override <cap>=<binding>` is supplied at install, the kernel does **not** call its default driver for that capability. Instead it materializes the binding the user specified.

Supported override forms (v1):

| Form | Example | Meaning |
|---|---|---|
| **Kernel driver** | `--override llm=driver-llm-anthropic-only` | A different kernel driver (must be loaded). |
| **HTTP endpoint** | `--override llm=http://127.0.0.1:11434/v1/chat/completions` | Treat as an OpenAI-compat backend. Kernel proxies / passes through. |
| **CLI subprocess** | `--override deliverer.telegram=cli:tg-cli send` | Kernel spawns the CLI per call with a documented stdin/stdout protocol. |
| **Custom Layer module** | `--override llm=module:./my-llm-layer.js` | App's TS runtime imports the module at startup and provides the resulting Layer. (App-runtime path, not kernel.) |
| **Disabled** | `--disable optional.gcal` | The app's port stays unbound; the app's code feature-gates around it. |

The `module:` form is what makes "user-supplied Layer" work for ejected apps with no kernel running: the app process itself loads the Layer; the manifest just records that the override is in effect for telemetry / status.

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

-- one row per (install, capability) — the resolved binding
CREATE TABLE gctrl_app_bindings (
  install_name   TEXT NOT NULL REFERENCES gctrl_app_installs(name),
  capability     TEXT NOT NULL,            -- e.g. "llm"
  binding_kind   TEXT NOT NULL,            -- driver | http | cli | module | disabled
  binding_value  TEXT NOT NULL,            -- driver name / URL / cli template / module path / "disabled"
  required       INTEGER NOT NULL,         -- 1 if from [requires], 0 if [optional]
  resolved_at    TEXT NOT NULL,
  PRIMARY KEY (install_name, capability)
);
```

Both tables are app-namespaced (`gctrl_*` is kernel infra, not per-app data — it tracks *which apps are installed*).

## What this gives ejection

When an app is installed on a non-gctrl host, the operator runs (or has Claude Code generate):

```sh
gctrl app install ./uebermensch \
  --override llm=module:./my-llm-layer.js \
  --override deliverer.telegram=cli:my-tg-bot \
  --override vault.sync=disabled \
  --disable optional.gcal
```

The app's source is unchanged. The `LlmService` port resolves at startup to the user's Layer module; `deliverer.telegram` shells out to the user's CLI; vault.sync is off (the user is fine with local-only); gcal is disabled (no calendar integration available).

This is exactly the spec correction's ask: *"It's user role to use LLM to configure the app to use opinionated driver or clis, or ignore particular feature set."*

## Versioning + reload

- The manifest carries `version`. On `gctrl app reload`, the kernel re-reads the file. If the capability set has *changed* (new `[requires]` entry, removed `[optional]`, etc.), the kernel re-resolves bindings and asks the user to confirm any new required-capability bindings.
- Schedules are reconciled by `name` — re-running `reload` is idempotent.
- Vault mounts are append-only by `name` — removing a mount from the manifest does NOT remove it from `gctrl_vault_mounts` (operator-owned data; explicit `--prune-mounts` flag for the destructive case).

## What apps look like at runtime

Apps continue to define ports (`LlmService`, `DelivererService`, `VaultWriterPort`, …) in their TypeScript / Rust source. The default Layer wires those ports to the *kernel HTTP routes* the capability registry pins (`/api/llm/*`, `/api/telegram/send`, `/api/vault/*`, `/api/sync/vault/*`, …).

The `gctrl-app.toml` manifest is the **declarative** description of those bindings. The runtime Layer wiring is the **operational** consequence. They're two views of the same contract — one for the operator/installer, one for the app's code.

## What is explicitly out of scope (v1)

- **App marketplace / registry** — `gctrl app install <ref>` only takes a local path or git URL.
- **Sandbox enforcement** — bindings are advisory; the app *could* still call `process.env` directly, but linting + reviewer checks (per app-decoupling.md § Boundary Tests) catch that.
- **Multi-tenancy** — one install per app name per kernel. Running two parallel uebermensch installs is not supported.
- **Hot reload of bindings without restart** — `gctrl app reload` requires the app process to restart to pick up new bindings.

## Migration path for uebermensch

1. **Land this spec.** No code changes yet.
2. **Add `gctrl-app.toml`** to `apps/uebermensch/` describing what the app needs today (LLM, deliverers, vault.write, vault.sync, secrets, optional gcal, optional brave search, optional browser.cdp).
3. **Build the kernel-side install machinery**: `/api/app/install`, `/api/app/status`, `gctrl_app_installs` + `gctrl_app_bindings` tables, capability registry.
4. **Replace `lib/mode.ts` + `--mode` flag** with: read the install record at startup; resolve bindings; build the runtime Layer accordingly. The `Mode` enum becomes legacy / deleted.
5. **Document the override flags** so an operator on a non-gctrl host (or with opinionated CLIs) can produce a working install.

## Why this is the right shape

It encodes the spec correction: apps declare *what they need*, the host decides *how to fulfill it*. Defaults make the gctrl-host happy path zero-effort. Overrides give operators (often LLM-assisted) the seam to install on a different OS without forking app source. And the manifest is the single artifact that an LLM can read to *generate* the override flags for a new host — closing the "user role to use LLM to configure the app" loop the user originally described.
