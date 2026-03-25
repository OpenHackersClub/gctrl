# gctl -- GroundCtrl

Local-first operating system for human+agent teams. Unix-inspired: **Kernel** (telemetry, storage, guardrails, network, browser, sync), **Shell** (CLI, HTTP API, query engine), **Applications & Utilities** (board, eval, capacity, net tools).

Follows conventions from `@debuggingfuture/arch-taste.md`.

See `AGENTS.md` for the full knowledge base index, invariants, and documentation standards. See `specs/` for architecture, domain model, principles, and implementation details.

## Build & Test

```sh
cargo build
cargo test
cargo run -- serve

cd packages/gctl-board
bun install && bun run test
```

## Running Locally

```sh
# Start server, then use HTTP API
cargo run -- serve
curl http://127.0.0.1:4318/api/sessions

# Or query directly (when server is NOT running)
cargo run -- sessions
cargo run -- analytics overview

# Web scraping
cargo run -- net fetch https://docs.example.com/getting-started
cargo run -- net crawl https://docs.example.com --depth 3 --max-pages 50
cargo run -- net compact docs.example.com
```
