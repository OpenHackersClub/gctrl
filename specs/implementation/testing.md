# Testing Strategy

Follows the test pyramid from `@debuggingfuture/arch-taste.md`. For non-negotiable testing rules, see `specs/principles.md` § Testing Invariants.

## Test Pyramid

```
  /  Soak  \          Long-running stability & perf (hours)
 / Acceptance\        End-to-end user journeys (minutes)
/ Integration  \      Adapter + real infra (seconds)
/___Unit________\     Domain logic, pure functions (ms)
```

## How to Run

```sh
# Rust (daemon + CLI) — 87 tests across 9 crates
cargo test

# Effect-TS (gctl-board) — 6 schema validation tests
cd packages/gctl-board
bun install
bun run test
```

## Unit Tests (Domain)

1. Pure domain logic lives in `#[cfg(test)] mod tests` blocks — no mocks needed thanks to hexagonal architecture.
2. Storage tests MUST use DuckDB `:memory:` — fast, isolated, no file I/O.
3. Effect-TS schemas validated with `vitest` + `Schema.decodeUnknownSync`.

## Integration Tests

1. `crates/gctl-otel/tests/pipeline.rs` — 11-step end-to-end pipeline test covering: ingest OTLP → verify aggregation → trace tree → auto-score → analytics.
2. axum router tests via `tower::ServiceExt::oneshot` (in-process HTTP, no real server needed).

## Acceptance Tests

End-to-end user journeys against local or sandbox environments. See `@debuggingfuture/arch-taste.md` for Miniflare, Cloudflare Workers sandbox, and Playwright patterns.

## Soak Tests

Sustained load over hours to surface memory leaks, connection pool exhaustion, and degradation. See `@debuggingfuture/arch-taste.md` for k6 patterns and monitoring setup.

## Crate-Specific Notes

| Crate | Test Approach |
|-------|--------------|
| `gctl-core` | Pure unit tests, no I/O |
| `gctl-storage` | DuckDB `:memory:`, schema + CRUD |
| `gctl-otel` | axum oneshot, full pipeline integration |
| `gctl-guardrails` | Unit tests on policy logic |
| `gctl-query` | DuckDB `:memory:`, query execution |
| `gctl-net` | `tempfile::TempDir` for filesystem, 18 tests |
| `gctl-board` (TS) | vitest + `Schema.decodeUnknownSync` |
