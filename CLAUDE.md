# gctl — GroundCtrl

Local-first operating system for human+agent teams.

## Build & Test

```sh
cargo build          # build all crates
cargo test           # run all tests (45 tests across 9 crates)
cargo run -- status  # run CLI
cargo run -- serve   # start OTel receiver on :4318
```

## Architecture

Cargo workspace with 9 crates in `crates/`:
- `gctl-core` — Domain types, traits, config, errors
- `gctl-cli` — Binary (`gctl`), clap subcommands
- `gctl-storage` — DuckDB embedded storage
- `gctl-otel` — OTLP HTTP receiver (axum)
- `gctl-guardrails` — Policy engine (budget, loop, blocklist, diff size)
- `gctl-query` — Named queries, agent data interface
- `gctl-proxy` — MITM proxy (stub, Phase 2)
- `gctl-net` — Web crawl/fetch (stub, Phase 2)
- `gctl-sync` — R2 sync (stub, Phase 4)

## Conventions

- Tests live alongside source in `#[cfg(test)] mod tests`
- DuckDB in-memory (`:memory:`) for all unit/integration tests
- Timestamps stored as RFC3339 VARCHAR in DuckDB
- All errors via `thiserror` in `gctl-core::error`
- Config defaults in `gctl-core::config`

## Git Workflow

Always use feature branches. Never push directly to main.
