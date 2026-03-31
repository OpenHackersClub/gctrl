# GroundCtrl (gctl)

A small, local-first orchestration layer for human+agent teams, modeled after Unix.

Install, run `gctl serve`, and you have a working ground control station. No config files, no cloud accounts, no Docker.

## Why

- **Unix philosophy.** The kernel is four small primitives (telemetry, storage, guardrails, orchestrator). Applications and utilities are all optional — use what you need, ignore the rest. Loadable kernel modules (drivers) connect to the tools you already use (Linear, Notion, Obsidian, Arize Phoenix) instead of replacing them.
- **Individual workflow is personal.** Team workflows like Scrum are often similar across organizations, but how an individual developer works with their agents is highly personalized. gctl gives you the primitives to build *your* workflow, not a prescribed one.
- **Malleable by design.** Prompts (AGENTS.md, WORKFLOW.md) are the first-class extension surface. Load drivers, add CLI commands, or rewrite policies — without forking. A gentle slope from user to creator.

Read more at [specs/principles.md](specs/principles.md).

## Quick Start

```sh
cargo build
cargo run -- serve           # OTel receiver on :4318
cargo run -- status          # health check
cargo run -- sessions        # list agent sessions
```

## Architecture

```mermaid
graph TB
    subgraph Agents["AGENTS"]
        Claude["Claude Code"]
        Aider["Aider"]
        Custom["Any Agent"]
    end

    subgraph Apps["APPLICATIONS & UTILITIES (all optional)"]
        Board["gctl-board<br/>(kanban)"]
        Eval["Observe & Eval"]
        NetUtils["net fetch/crawl/compact"]
        BrowserUtils["browser goto/snap/click"]
    end

    subgraph Shell["SHELL"]
        CLI["CLI Dispatcher"]
        API["HTTP API"]
        Query["Query Engine"]
    end

    subgraph Kernel["KERNEL (small, always present)"]
        Telemetry["Telemetry"]
        Storage["Storage"]
        Guardrails["Guardrails"]
        Orchestrator["Orchestrator"]
    end

    subgraph Drivers["DRIVERS (loadable kernel modules)"]
        DrvLinear["driver-linear"]
        DrvGitHub["driver-github"]
        DrvPhoenix["driver-phoenix"]
    end

    subgraph ExtApps["EXTERNAL APPS"]
        Linear["Linear"]
        GitHub["GitHub"]
        Phoenix["Arize Phoenix"]
    end

    Agents -->|"OTLP / HTTP / CLI"| Shell
    Apps -->|"Shell APIs"| Shell
    Shell -->|"syscalls"| Kernel
    Drivers -->|"kernel interfaces"| Kernel
    ExtApps -.->|"external APIs"| Drivers
```

```
Kernel:       telemetry, storage, guardrails, orchestrator + drivers (loadable kernel modules)
Shell:        CLI dispatcher, HTTP API, query engine
Apps/Utils:   gctl-board, observe & eval, net fetch/crawl/compact, ...
```

See [specs/architecture/](specs/architecture/), [specs/comparison.md](specs/comparison.md), and [AGENTS.md](AGENTS.md) for the full knowledge base.
