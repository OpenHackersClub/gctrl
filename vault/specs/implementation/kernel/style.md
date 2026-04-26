# Kernel Style Guide (Rust — `crates/`)

## DuckDB Storage

1. **Timestamps**: Store as RFC3339 VARCHAR (not TIMESTAMP) due to DuckDB type mapping constraints.
2. **Session aggregation**: Session cost and token counts auto-aggregated from child spans on insert. An UPDATE runs after `insert_spans` to roll up totals.
3. **Single-writer lock**: DuckDB allows only one writer at a time. When the server is running, use the HTTP API or pass `--db` to target a separate file.
4. **Application table namespacing**: New application tables MUST use prefixed names to avoid collisions. Kernel-owned tables have no prefix.

| Application       | Prefix       |
|-------------------|--------------|
| Board (kanban)    | `board_*`    |
| Observe & Eval    | `eval_*`     |
| Capacity planning | `capacity_*` |

## CLI (`clap` derive macros)

Use `clap` derive macros. Global flags (like `--db`) on the top-level struct:

```rust
#[derive(Parser)]
#[command(name = "gctrl")]
struct Cli {
    #[arg(long, global = true)]
    db: Option<String>,
    #[command(subcommand)]
    command: Commands,
}
```

## Error Types (`thiserror`)

Structured error enums with `thiserror`:

```rust
#[derive(Debug, Error)]
enum GctlError {
    #[error("storage error: {0}")]
    Storage(String),
    #[error("guardrail violation: {0}")]
    GuardrailViolation(String),
}
```

## Guardrail Policies (trait objects)

Compose as trait objects in a policy chain:

```rust
pub trait GuardrailPolicy: Send + Sync {
    fn name(&self) -> &str;
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}
```

## Async & Serialization

- `tokio` async runtime (full features)
- `serde` / `serde_json` for all (de)serialization
- `chrono` for datetime, always UTC

## Testing

- `DuckDbStore::open(":memory:")` for all DB tests
- `tempfile::TempDir` for filesystem tests (gctrl-net, gctrl-context)
- `tower::ServiceExt::oneshot` for axum router tests
- See [testing.md](../testing.md) for the full test strategy
