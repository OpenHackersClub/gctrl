# Monorepo Structure

gctl uses a **single Nx-managed monorepo** for Rust, TypeScript (Effect-TS), and Lean 4 code. Nx orchestrates builds, tests, and caching across all three runtimes. Cargo workspace handles Rust crate dependency resolution; Lake handles Lean 4 builds; Nx handles cross-language task orchestration, affected detection, and caching.

## Directory Layout

```
gctrl/
├── nx.json                    # Nx workspace config
├── package.json               # Root package.json (workspace, Nx deps)
├── Cargo.toml                 # Rust workspace (crate members)
├── tsconfig.base.json         # Shared TS compiler options
│
├── crates/                    # Rust crates (Cargo workspace)
│   ├── gctl-core/             # Domain: types, errors, config, context types
│   │
│   │  # --- Kernel (primitives) ---
│   ├── gctl-storage/          # Kernel: DuckDB embedded storage
│   ├── gctl-otel/             # Kernel: OTel receiver + HTTP API
│   ├── gctl-guardrails/       # Kernel: policy engine
│   ├── gctl-context/          # Kernel: context manager (DuckDB + filesystem)
│   ├── gctl-proxy/            # Kernel: MITM proxy (stub)
│   ├── gctl-browser/          # Kernel: CDP browser daemon
│   ├── gctl-sync/             # Kernel: R2 cloud sync (stub)
│   │
│   │  # --- Shell (dispatcher + interface) ---
│   ├── gctl-cli/              # Shell: CLI dispatcher (clap)
│   ├── gctl-query/            # Shell: query executor
│   │
│   │  # --- Utilities ---
│   └── gctl-net/              # Utility: web fetch, crawl, compaction
│
├── packages/                  # TypeScript packages (Effect-TS)
│   │  # --- Applications ---
│   ├── gctl-board/            # App: Effect-TS kanban (schemas, services)
│   │  # --- Future TS packages ---
│   └── ...
│
├── specs/                     # Architecture, design, and formal specs
│   ├── architecture/          # System structure (kernel/shell/apps layers)
│   ├── implementation/        # Coding patterns, testing, repo structure
│   ├── formal/                # Lean 4 formal verification (Lake project)
│   │   ├── KernelSpec/        # Kernel state machine proofs (83 theorems)
│   │   ├── KernelSpec.lean    # Root import file
│   │   ├── lakefile.lean      # Lake build config
│   │   └── lean-toolchain     # Lean 4 version pin
│   └── ...
│
├── specs/                     # Architecture and design specs
├── AGENTS.md
├── CLAUDE.md
└── Request.md
```

## Three Codebases, One Repo

gctl separates concerns across three runtimes. Each has its own build system, dependency management, and can be developed independently. Nx provides the cross-language orchestration layer.

| Codebase | Language | Directory | Build System | Responsibility |
|----------|----------|-----------|-------------|----------------|
| **Kernel** | Rust | `crates/` | Cargo workspace | Core primitives: storage, telemetry, guardrails, context, sync, proxy, browser. CLI dispatcher. All kernel-owned tables. Single `gctl` binary. |
| **Specs (Formal)** | Lean 4 | `specs/formal/` | Lake | Formal verification of state machines: Session, Task, Orchestrator, RunAttempt, IssueState, TaskDAG. 83 theorems, zero `sorry`. Gates kernel state machine changes. |
| **Applications** | TypeScript (Effect-TS) | `packages/` | npm/bun + tsup | Application-level logic: gctl-board (kanban), future apps. Each app owns its namespaced tables, domain model, and services. Communicates with kernel via shell (HTTP API or CLI subprocess). |

**Each app can take its own codebase.** Applications under `packages/` are independent npm packages. They depend on the kernel only through the shell (HTTP API on `:4318` or `gctl` CLI subprocess). This means:

- An app can be extracted to its own repo and still work — it just talks to the `gctl` daemon over HTTP.
- Apps MUST NOT import Rust crates directly (no FFI, no shared memory).
- Apps MUST NOT join across other apps' tables — cross-app data flows through kernel IPC.
- Each app declares its own `package.json`, `tsconfig.json`, and test setup.

**Lean 4 specs gate Rust changes.** The formal proofs in `specs/formal/` must pass (`cd specs/formal && lake build`) before the corresponding Rust kernel crate can merge state machine changes. Nx enforces this via `dependsOn` in `project.json`.

## Nx Configuration

### Why Nx

1. **Cross-language orchestration.** Nx manages Cargo, TypeScript, and Lean 4 build/test targets from a single task graph. `nx affected` detects changes across all three runtimes.
2. **Computation caching.** Nx caches task outputs (build artifacts, test results) locally and optionally remotely (Nx Cloud). Cargo's incremental compilation handles Rust; Lake handles Lean 4; Nx caches the TypeScript side and cross-project dependencies.
3. **Task dependencies.** Nx's task pipeline ensures Lean 4 proofs pass before the Rust orchestration crate can change state machine logic, and Rust builds complete before TypeScript packages that depend on the CLI binary.
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
    "typescript": ["{projectRoot}/src/**/*.ts", "{projectRoot}/package.json", "{projectRoot}/tsconfig.json"],
    "lean": ["{projectRoot}/**/*.lean", "{projectRoot}/lakefile.lean", "{projectRoot}/lean-toolchain"]
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
  "workspaces": ["packages/*"],
  "devDependencies": {
    "nx": "^21",
    "@monodon/rust": "^3",
    "typescript": "^5.7"
  },
  "scripts": {
    "build": "nx run-many -t build",
    "test": "nx run-many -t test",
    "test:rust": "cargo test",
    "test:ts": "nx run-many -t test --projects=packages/*",
    "lint": "nx run-many -t lint"
  }
}
```

### Per-Crate `project.json` (Rust)

Each Rust crate MAY have a `project.json` for Nx target overrides. The `@monodon/rust` plugin auto-infers `build` and `test` targets from `Cargo.toml`, so `project.json` is only needed for custom targets.

```jsonc
// crates/gctl-cli/project.json (example)
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
// packages/gctl-board/package.json
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

## Triple Build Systems

| Concern | Tool | Scope |
|---------|------|-------|
| Rust crate resolution, compilation | Cargo | `crates/*` |
| TypeScript compilation, bundling | tsup / tsc | `packages/*` |
| Lean 4 compilation, proof checking | Lake | `specs/formal/` |
| Task orchestration, caching, affected | Nx | Entire workspace |
| Dependency graph, task ordering | Nx task pipeline | Cross-language |

Cargo, Lake, and Nx coexist. Nx does NOT replace Cargo or Lake — it wraps their commands and adds caching, affected detection, and cross-language task ordering on top.

### Per-Project Config (Lean 4)

Lean 4 projects use a `project.json` with custom executor commands wrapping Lake.

```jsonc
// specs/formal/project.json
{
  "name": "kernel-spec-lean",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "options": {
        "command": "lake build",
        "cwd": "specs/formal"
      },
      "inputs": ["lean"]
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "lake build",
        "cwd": "specs/formal"
      },
      "inputs": ["lean"]
    }
  }
}
```

The Rust orchestration crate MUST depend on the Lean 4 proofs passing:

```jsonc
// crates/gctl-orch/project.json (partial)
{
  "targets": {
    "test": {
      "dependsOn": ["kernel-spec-lean:build"]
    }
  }
}
```

This ensures `lake build` (proof checking) passes before Rust tests can run for the orchestration crate.

### Running Tasks

```sh
# Everything (Rust + TypeScript + Lean 4)
nx run-many -t build
nx run-many -t test

# Affected only (based on git diff)
nx affected -t test

# Single project
nx test gctl-board
nx build gctl-cli
nx build kernel-spec-lean

# Rust directly (bypasses Nx, no cross-language cache)
cargo build
cargo test

# TypeScript directly
cd packages/gctl-board && bun run test

# Lean 4 directly (bypasses Nx)
cd specs/formal && lake build
```

## Conventions

1. **Rust crates live in `crates/`.** Named `gctl-{name}`. Managed by Cargo workspace.
2. **TypeScript packages live in `packages/`.** Named `gctl-{name}`. Managed by npm/bun workspaces + Nx.
3. **Lean 4 formal specs live in `specs/formal/`.** Managed by Lake. Has its own `lakefile.lean` and pinned `lean-toolchain`. Specs are part of the `specs/` tree because they are the formal expression of the architecture — not a separate runtime codebase.
4. **Shared nothing between runtimes at build time.** TypeScript packages communicate with Rust via the shell (HTTP API or CLI subprocess), never via FFI or shared memory. Lean 4 communicates with Rust via exported transition tables (JSON), not via FFI.
5. **Nx is the top-level orchestrator.** Use `nx run-many -t test` for CI, not separate `cargo test && bun run test && lake build` steps.
6. **Cache inputs MUST be explicit.** Rust targets use the `rust` named input; TypeScript targets use the `typescript` named input; Lean 4 targets use the `lean` named input. This prevents false cache hits across languages.
7. **Feature-gated Rust crates.** Optional kernel subsystems (proxy, browser, sync) use Cargo feature flags. Nx respects these via `@monodon/rust` executor options.
8. **Lean 4 proofs gate Rust state machine changes.** The Lean 4 `lake build` target MUST pass before the corresponding Rust crate's tests can run. This is enforced via Nx `dependsOn` in the Rust crate's `project.json`.
