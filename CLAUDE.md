# gctl — GroundCtrl

Local-first operating system for human+agent teams.

Follows conventions from `@debuggingfuture/arch-taste.md`.

## Build & Test

```sh
# Rust (daemon + CLI)
cargo build
cargo test                   # 70 Rust tests across 9 crates
cargo run -- status
cargo run -- serve           # OTel receiver on :4318
cargo run -- --db /tmp/test.duckdb serve --port 4320

# Effect-TS (gctl-board)
cd packages/gctl-board
bun install
bun run test                 # 6 schema validation tests
```

## Running Locally

```sh
# Terminal 1: start the server
cargo run -- serve

# Terminal 2: send OTLP spans
curl -X POST http://127.0.0.1:4318/v1/traces -H "Content-Type: application/json" -d '...'

# Query via HTTP API (while server is running)
curl http://127.0.0.1:4318/api/sessions
curl http://127.0.0.1:4318/api/sessions/{id}/tree    # Langfuse-style trace tree
curl http://127.0.0.1:4318/api/analytics/cost
curl http://127.0.0.1:4318/api/analytics/latency

# Or query directly (when server is NOT running)
cargo run -- sessions
cargo run -- analytics overview
```

**DuckDB lock**: DuckDB is single-writer. If the server is running, use the HTTP API endpoints instead of CLI query commands (or use `--db` to point to a different DB file).

## Architecture — Hexagonal + DDD

Follows hexagonal architecture (ports & adapters) and domain-driven design patterns from arch-taste.md.

### Domain Layer (`gctl-core`)
Pure types, errors, and business rules. No I/O dependencies.
- **Aggregates**: Session (with Span children), TrafficRecord
- **Value Objects**: SpanId, SessionId, TraceId (branded string newtypes)
- **Domain Types**: SpanType (Generation/Span/Event), SpanStatus, SessionStatus, PolicyDecision
- **Domain Errors**: `GctlError` variants via `thiserror` (Storage, Config, GuardrailViolation, etc.)

### Ports (`gctl-core` traits + service interfaces)
Abstract interfaces defining how domain talks to the outside:
- `DuckDbStore` methods as the storage port
- `GuardrailPolicy` trait for composable policy chain
- `BoardService` / `DependencyResolver` (Effect-TS Context.Tag services)

### Adapters (`gctl-storage`, `gctl-otel`, `gctl-proxy`)
Concrete implementations wired at the edge:
- `DuckDbStore` — DuckDB embedded storage (11 tables)
- OTel receiver — axum HTTP server, OTLP JSON ingestion
- Guardrail policies — SessionBudgetPolicy, LoopDetectionPolicy, etc.

### Entrypoints (`gctl-cli`, HTTP API)
- CLI binary (`gctl`) with 19 clap subcommands
- HTTP API (21 endpoints) served by axum

### Monorepo Structure

```
gctrl/
├── crates/                    # Rust workspace
│   ├── gctl-core/             # Domain: types, errors, config
│   ├── gctl-cli/              # Entrypoint: CLI binary
│   ├── gctl-storage/          # Adapter: DuckDB storage
│   ├── gctl-otel/             # Adapter: OTel receiver + HTTP API
│   ├── gctl-guardrails/       # Domain: policy engine
│   ├── gctl-query/            # Domain: query executor
│   ├── gctl-proxy/            # Adapter: MITM proxy (stub)
│   ├── gctl-net/              # Adapter: web crawl (stub)
│   └── gctl-sync/             # Adapter: R2 sync (stub)
├── packages/                  # TypeScript packages
│   └── gctl-board/            # Effect-TS kanban (schemas, services)
│       ├── src/schema/        # Domain: Issue, Board, Project schemas
│       ├── src/services/      # Ports: BoardService, DependencyResolver
│       └── test/              # vitest tests
├── PRD.md
├── TECH_SPEC.md
└── Request.md
```

## Effect-TS Patterns (gctl-board)

Follow idiomatic Effect-TS from arch-taste.md:

### Never access `._tag` directly
Use proper combinators:
- `Effect.catchTag` / `Effect.catchTags` for error handling
- `Match.tag` + `Match.exhaustive` for pattern matching
- `Schema.TaggedError` / `Schema.TaggedClass` for defining tagged types

### Tagged Errors
```typescript
class BoardError extends Schema.TaggedError<BoardError>()(
  "BoardError", { message: Schema.String }
) {}

class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError", { issueId: Schema.String }
) {}
```

### Service Definitions (Ports as Context.Tag)
```typescript
class BoardService extends Context.Tag("BoardService")<
  BoardService,
  {
    readonly createIssue: (input: CreateIssueInput) => Effect.Effect<Issue, BoardError>
    readonly moveIssue: (id: IssueId, status: IssueStatus) => Effect.Effect<Issue, BoardError | IssueNotFoundError>
  }
>() {}
```

### Layer Composition (Dependency Injection)
Wire adapters via Effect Layers, not runtime DI containers.

### Branded Types (Value Objects)
```typescript
const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
```

## Rust Patterns

### CLI (`clap` derive macros)
```rust
#[derive(Parser)]
#[command(name = "gctl")]
struct Cli {
    #[arg(long, global = true)]
    db: Option<String>,
    #[command(subcommand)]
    command: Commands,
}
```

### Error Types (`thiserror`)
```rust
#[derive(Debug, Error)]
enum GctlError {
    #[error("storage error: {0}")]
    Storage(String),
    #[error("guardrail violation: {0}")]
    GuardrailViolation(String),
}
```

### Composable Guardrails (trait objects)
```rust
pub trait GuardrailPolicy: Send + Sync {
    fn name(&self) -> &str;
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}
```

## Testing Strategy

Follows the test pyramid from arch-taste.md:

### Unit Tests (Domain)
- Pure domain logic in `#[cfg(test)] mod tests` — no mocks needed
- DuckDB `:memory:` for storage tests (fast, isolated)
- Effect-TS schemas validated with `vitest` + `Schema.decodeUnknownSync`

### Integration Tests
- `crates/gctl-otel/tests/pipeline.rs` — 11-step E2E pipeline test
- axum router tests via `tower::ServiceExt::oneshot` (in-process HTTP)
- Ingest OTLP → verify aggregation → trace tree → auto-score → analytics

### Conventions
- Red-green-refactor: write failing test first
- DuckDB in-memory for all tests — no file I/O, no cleanup
- Timestamps stored as RFC3339 VARCHAR in DuckDB
- Session cost/tokens auto-aggregated from spans on insert
- Auto-scoring on session end: span_count, error_count, generation_count, cost_per_generation

## Git Workflow

Always use feature branches. Never push directly to main.
