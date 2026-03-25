# gctl Style Guide

Coding patterns and conventions for the gctl codebase. Extracted from project CLAUDE.md and arch-taste.md.

---

## Generic Conventions

### 1. Architecture Diagrams

MUST use mermaid for architecture diagrams. MUST NOT use PNG/SVG image files for diagrams that can be expressed as code.

### 2. DuckDB Storage

1. **Timestamps**: MUST store as RFC3339 VARCHAR in DuckDB (not TIMESTAMP), due to DuckDB type mapping constraints.
2. **Session aggregation**: Session cost and token counts MUST be auto-aggregated from child spans on insert. An UPDATE MUST run after `insert_spans` to roll up totals.
3. **Single-writer lock**: DuckDB allows only one writer at a time. When the server is running, MUST use the HTTP API instead of CLI query commands, or pass `--db` to target a separate DB file.

### 3. Application Table Namespacing

New application tables MUST use namespaced prefixes to avoid collisions across bounded contexts:

| Application       | Prefix       |
|-------------------|--------------|
| Board (kanban)    | `board_*`    |
| Observe & Eval    | `eval_*`     |
| Capacity planning | `capacity_*` |

### 4. Testing

See `specs/implementation/testing.md` for the full test strategy and crate-specific patterns. See `specs/principles.md` § Testing Invariants for the non-negotiable rules.

### 5. Hexagonal Architecture (Ports & Adapters)

- **Domain** — pure business logic, no framework or I/O dependencies
- **Ports** — interfaces/types defining how domain talks to the outside
- **Adapters** — concrete implementations wired at the edge
- Dependency injection via Effect Layers (TypeScript) or trait objects (Rust), not runtime DI containers

### 6. Domain-Driven Design

- Bounded contexts map to packages/crates — each context owns its domain types
- Value objects modeled as branded types (TypeScript) or newtypes (Rust) — immutable, equality by value
- Domain events for cross-context communication
- Ubiquitous language — code names match what the business says

---

## Rust Patterns

### 1. CLI (`clap` derive macros)

MUST use `clap` derive macros for argument parsing. Global flags (like `--db`) MUST be declared on the top-level struct:

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

### 2. Error Types (`thiserror`)

MUST define structured error enums with `thiserror` for consistent error messages:

```rust
#[derive(Debug, Error)]
enum GctlError {
    #[error("storage error: {0}")]
    Storage(String),
    #[error("guardrail violation: {0}")]
    GuardrailViolation(String),
}
```

### 3. Composable Guardrails (trait objects)

Guardrail policies MUST be defined as trait objects, composed into a policy chain at runtime:

```rust
pub trait GuardrailPolicy: Send + Sync {
    fn name(&self) -> &str;
    fn check(&self, context: &ExecutionContext) -> PolicyDecision;
}
```

### 4. Async Runtime

MUST use `tokio` async runtime. MUST use `serde` for JSON (de)serialization.

---

## TypeScript / Effect-TS Patterns (gctl-board)

### 1. Tag Access (see `specs/principles.md`, Effect-TS Invariant #1)

Use proper Effect-TS combinators instead of reading `._tag`:

- `Effect.catchTag` / `Effect.catchTags` for error handling
- `Match.tag` + `Match.exhaustive` for pattern matching
- `Schema.TaggedError` / `Schema.TaggedClass` for defining tagged types

### 2. Tagged Errors

Define domain errors as tagged error classes with structured fields:

```typescript
class BoardError extends Schema.TaggedError<BoardError>()(
  "BoardError", { message: Schema.String }
) {}

class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError", { issueId: Schema.String }
) {}
```

### 3. Service Definitions (Ports as Context.Tag)

Model service ports as `Context.Tag` classes. Each method MUST return an `Effect` with typed errors:

```typescript
class BoardService extends Context.Tag("BoardService")<
  BoardService,
  {
    readonly createIssue: (input: CreateIssueInput) => Effect.Effect<Issue, BoardError>
    readonly moveIssue: (id: IssueId, status: IssueStatus) => Effect.Effect<Issue, BoardError | IssueNotFoundError>
  }
>() {}
```

### 4. Layer Composition (Dependency Injection)

Wire adapters via Effect Layers, not runtime DI containers. Layers MUST be composed at the edge (entrypoint), keeping domain logic pure.

### 5. Branded Types (Value Objects)

Model value objects as branded types to prevent accidental mixing of string IDs:

```typescript
const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
```

### 6. Functional Style

- Prefer `pipe` / `Effect.gen` generators over imperative chains
- No `any` types — use `unknown` + Schema decode
- No mutable global state — use Effect Ref or Context
- No barrel exports (`index.ts` re-exporting everything) — import directly
