# Agent Coordination — gctl

## Crate Ownership

When modifying code, respect crate boundaries:
- Types/traits/config changes go in `gctl-core`
- Storage schema changes go in `gctl-storage/src/schema.rs`
- New CLI commands go in `gctl-cli/src/commands/`
- New guardrail policies go in `gctl-guardrails/src/policies.rs`

## Testing Requirements

- Every new public function must have at least one test
- Storage tests use `:memory:` DuckDB — no file I/O
- OTel tests use `axum::test` with `tower::ServiceExt::oneshot`
- Run `cargo test` before committing

## Adding a New CLI Command

1. Add variant to `Commands` enum in `gctl-cli/src/main.rs`
2. Create handler in `gctl-cli/src/commands/<name>.rs`
3. Add `pub mod <name>` in `gctl-cli/src/commands/mod.rs`
4. Wire up in the `match` block in `main()`
