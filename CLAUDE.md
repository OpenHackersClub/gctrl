# gctl — GroundCtrl

Local-first operating system for human+agent teams.

## Build & Test

```sh
cargo build                  # build all crates
cargo test                   # run all tests (49 tests across 9 crates)
cargo run -- status          # show config and paths
cargo run -- serve           # start OTel receiver on :4318
cargo run -- --db /tmp/test.duckdb serve --port 4320  # custom DB + port
```

## Running Locally

```sh
# Terminal 1: start the server
cargo run -- serve

# Terminal 2: send OTLP spans
curl -X POST http://127.0.0.1:4318/v1/traces -H "Content-Type: application/json" -d '...'

# Query via HTTP API (while server is running)
curl http://127.0.0.1:4318/api/sessions
curl http://127.0.0.1:4318/api/sessions/{id}/spans
curl http://127.0.0.1:4318/api/analytics

# Or query directly (when server is NOT running)
cargo run -- sessions
cargo run -- analytics
```

**DuckDB lock**: DuckDB is single-writer. If the server is running, use the HTTP API endpoints instead of CLI query commands (or use `--db` to point to a different DB file).

## Architecture

Cargo workspace with 9 crates in `crates/`:
- `gctl-core` — Domain types, traits, config, errors
- `gctl-cli` — Binary (`gctl`), clap subcommands, global `--db` flag
- `gctl-storage` — DuckDB embedded storage, session aggregation
- `gctl-otel` — OTLP HTTP receiver (axum) + query API endpoints
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
- Session cost/tokens auto-aggregated from spans on insert

## Git Workflow

Always use feature branches. Never push directly to main.
