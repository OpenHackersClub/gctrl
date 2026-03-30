# Monorepo Structure

gctl uses a **single Nx-managed monorepo** for Rust and TypeScript (Effect-TS) code. Nx orchestrates builds, tests, and caching across both runtimes. Cargo workspace handles Rust crate dependency resolution; Nx handles cross-language task orchestration, affected detection, and caching.

## Directory Layout

```
gctrl/
├── nx.json                    # Nx workspace config
├── package.json               # Root package.json (workspace, Nx deps)
├── Cargo.toml                 # Rust workspace (crate members)
├── tsconfig.base.json         # Shared TS compiler options
│
├── kernel/                    # Rust kernel (Cargo workspace)
│   └── crates/
│       ├── gctl-core/         # Domain: types, errors, config, port traits
│       │
│       │  # --- Kernel primitives ---
│       ├── gctl-storage/      # DuckDB embedded storage
│       ├── gctl-otel/         # OTel receiver + HTTP API (:4318)
│       ├── gctl-guardrails/   # Policy engine
│       ├── gctl-context/      # Context manager (DuckDB + filesystem)
│       ├── gctl-query/        # Guardrailed query executor
│       ├── gctl-net/          # Web fetch, crawl, compaction
│       ├── gctl-proxy/        # MITM proxy (stub)
│       ├── gctl-browser/      # CDP browser daemon
│       ├── gctl-sync/         # R2 cloud sync (stub)
│       ├── gctl-scheduler/    # Scheduler port + adapters
│       │
│       │  # --- Daemon binary ---
│       └── gctl-cli/          # Minimal binary: `gctl serve`
│
├── shell/                     # Effect-TS CLI (user-facing)
│   └── gctl-shell/            # @effect/cli command dispatcher
│       ├── src/
│       │   ├── main.ts        # CLI entry point
│       │   ├── commands/      # Command implementations
│       │   ├── services/      # Port interfaces (KernelClient, GitHubClient)
│       │   └── adapters/      # Concrete adapters (HTTP, ccli subprocess)
│       ├── test/
│       └── package.json
│
├── apps/                      # Effect-TS applications
│   ├── gctl-board/            # App: kanban (schemas, services, adapters)
│   └── ...                    # Future: observe-eval, capacity
│
├── specs/                     # Architecture, design, and formal specs
│   ├── architecture/          # System structure (kernel/shell/apps layers)
│   └── implementation/        # Coding patterns, testing, repo structure
│
├── AGENTS.md
├── CLAUDE.md
└── Request.md
```

## Three Codebases, One Repo

gctl separates concerns across three codebases. Each has its own build system, dependency management, and can be developed independently. Nx provides the cross-language orchestration layer.

| Codebase | Language | Directory | Build System | Responsibility |
|----------|----------|-----------|-------------|----------------|
| **Kernel** | Rust | `kernel/crates/` | Cargo workspace | Core primitives: storage, telemetry, guardrails, context, query, sync, proxy, browser, scheduler. HTTP API on `:4318`. Minimal daemon binary (`gctl serve`). |
| **Shell** | TypeScript (Effect-TS) | `shell/gctl-shell/` | pnpm + tsup | User-facing CLI (`@effect/cli`). Invokes kernel via HTTP API. Communicates with external tools (GitHub, Slack) via `ccli` subprocess. |
| **Applications** | TypeScript (Effect-TS) | `apps/` | pnpm + tsup | Application-level logic: gctl-board (kanban), future apps. Each app owns its namespaced tables, domain model, and services. Communicates with kernel via HTTP API. |

**Kernel exposes, shell consumes.** The Rust kernel's only external interface is the HTTP API on `:4318`. The Effect-TS shell CLI calls this API to access kernel features. External tools (GitHub, Slack, AWS) are accessed from the shell via `ccli` subprocess adapters — never from the kernel.

**Each app can take its own codebase.** Applications under `apps/` are independent npm packages. They depend on the kernel only through the HTTP API on `:4318`. This means:

- An app can be extracted to its own repo and still work — it just talks to the `gctl` daemon over HTTP.
- Apps MUST NOT import Rust crates directly (no FFI, no shared memory).
- Apps MUST NOT join across other apps' tables — cross-app data flows through kernel IPC.
- Each app declares its own `package.json`, `tsconfig.json`, and test setup.

**Each app can be extracted.** Applications under `apps/` are independent npm packages. They depend on the kernel only through the HTTP API on `:4318`, so they can be moved to their own repo.

## Nx Configuration

### Why Nx

1. **Cross-language orchestration.** Nx manages Cargo, TypeScript, and Lean 4 build/test targets from a single task graph. `nx affected` detects changes across all three runtimes.
2. **Computation caching.** Nx caches task outputs (build artifacts, test results) locally and optionally remotely (Nx Cloud). Cargo's incremental compilation handles Rust; Lake handles Lean 4; Nx caches the TypeScript side and cross-project dependencies.
3. **Task dependencies.** Nx's task pipeline ensures Rust builds complete before TypeScript packages that depend on the CLI binary.
4. **Consistent developer experience.** One set of commands (`nx build`, `nx test`, `nx run-many`) regardless of language.

### `nx.json`

```jsonc
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],
      "cache": true
    },
    "test": {
      "dependsOn": ["build"],
      "cache": true
    },
    "lint": {
      "cache": true
    }
  },
  "namedInputs": {
    "rust": ["{projectRoot}/**/*.rs", "{projectRoot}/Cargo.toml", "{workspaceRoot}/Cargo.toml", "{workspaceRoot}/Cargo.lock"],
    "typescript": ["{projectRoot}/src/**/*.ts", "{projectRoot}/package.json", "{projectRoot}/tsconfig.json"]
  },
  "plugins": [
    {
      "plugin": "@monodon/rust",
      "options": {
        "buildTargetName": "build",
        "testTargetName": "test"
      }
    }
  ]
}
```

### Root `package.json`

```jsonc
{
  "name": "gctrl",
  "private": true,
  "workspaces": ["shell/*", "apps/*"],
  "devDependencies": {
    "nx": "^21",
    "@monodon/rust": "^3",
    "typescript": "^5.7"
  },
  "scripts": {
    "build": "nx run-many -t build",
    "test": "nx run-many -t test",
    "test:rust": "cargo test",
    "test:ts": "nx run-many -t test --projects=shell/*,apps/*",
    "lint": "nx run-many -t lint"
  }
}
```

### Per-Crate `project.json` (Rust)

Each Rust crate MAY have a `project.json` for Nx target overrides. The `@monodon/rust` plugin auto-infers `build` and `test` targets from `Cargo.toml`, so `project.json` is only needed for custom targets.

```jsonc
// kernel/crates/gctl-cli/project.json (example)
{
  "name": "gctl-cli",
  "targets": {
    "build": {
      "executor": "@monodon/rust:build",
      "options": {
        "release": false
      },
      "inputs": ["rust"]
    },
    "test": {
      "executor": "@monodon/rust:test",
      "inputs": ["rust"]
    }
  }
}
```

### Per-Package Config (TypeScript)

TypeScript packages use their `package.json` scripts. Nx infers targets from `package.json#scripts` automatically.

```jsonc
// shell/gctl-shell/package.json
{
  "name": "gctl-shell",
  "scripts": {
    "build": "tsup src/main.ts --format esm --dts",
    "test": "vitest run"
  },
  "nx": {
    "namedInputs": {
      "default": ["typescript"]
    }
  }
}
```

```jsonc
// apps/gctl-board/package.json
{
  "name": "gctl-board",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run"
  },
  "nx": {
    "namedInputs": {
      "default": ["typescript"]
    }
  }
}
```

## Build Systems

| Concern | Tool | Scope |
|---------|------|-------|
| Rust crate resolution, compilation | Cargo | `kernel/crates/*` |
| TypeScript compilation, bundling | tsup / tsc | `shell/*`, `apps/*` |
| Task orchestration, caching, affected | Nx | Entire workspace |
| Dependency graph, task ordering | Nx task pipeline | Cross-language |

Cargo and Nx coexist. Nx does NOT replace Cargo — it wraps its commands and adds caching, affected detection, and cross-language task ordering on top.

### Running Tasks

```sh
# Everything (Rust + TypeScript)
nx run-many -t build
nx run-many -t test

# Affected only (based on git diff)
nx affected -t test

# Single project
nx test gctl-shell
nx test gctl-board
nx build gctl-cli

# Rust kernel directly (bypasses Nx, no cross-language cache)
cd kernel && cargo build
cd kernel && cargo test

# Shell directly
cd shell/gctl-shell && pnpm run test

# Applications directly
cd apps/gctl-board && pnpm run test
```

## Conventions

1. **Rust kernel crates live in `kernel/crates/`.** Named `gctl-{name}`. Managed by Cargo workspace.
2. **Effect-TS shell lives in `shell/gctl-shell/`.** The user-facing CLI. Managed by pnpm + Nx.
3. **Effect-TS applications live in `apps/`.** Named `gctl-{name}`. Managed by pnpm + Nx.
4. **Shared nothing between runtimes at build time.** TypeScript (shell + apps) communicates with Rust via the kernel HTTP API on `:4318`, never via FFI or shared memory.
5. **Nx is the top-level orchestrator.** Use `nx run-many -t test` for CI, not separate `cargo test && pnpm run test` steps.
6. **Cache inputs MUST be explicit.** Rust targets use the `rust` named input; TypeScript targets use the `typescript` named input. This prevents false cache hits across languages.
7. **Feature-gated Rust crates.** Optional kernel subsystems (proxy, browser, sync) use Cargo feature flags. Nx respects these via `@monodon/rust` executor options.
8. **External tools accessed from shell only.** GitHub, Slack, AWS, and other external services are accessed via `ccli` subprocess adapters in the shell. Kernel crates MUST NOT call external tools directly.
