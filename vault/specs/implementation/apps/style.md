# Applications Style Guide (Effect-TS — `packages/`)

## Tag Access

Never access `._tag` directly. Use proper combinators:

- `Effect.catchTag` / `Effect.catchTags` for error handling
- `Match.tag` + `Match.exhaustive` for pattern matching
- `Schema.TaggedError` / `Schema.TaggedClass` for defining tagged types

## Tagged Errors

Define domain errors as tagged error classes with structured fields:

```typescript
class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError", { issueId: Schema.String }
) {}
```

## Service Definitions (Ports as Context.Tag)

Model service ports as `Context.Tag`. Each method returns `Effect` with typed errors:

```typescript
class BoardService extends Context.Tag("BoardService")<
  BoardService,
  {
    readonly createIssue: (input: CreateIssueInput) => Effect.Effect<Issue, BoardError>
    readonly moveIssue: (id: IssueId, status: IssueStatus) => Effect.Effect<Issue, BoardError | IssueNotFoundError>
  }
>() {}
```

## Layer Composition

Wire adapters via Effect Layers at the edge (entrypoint), keeping domain logic pure.

## Branded Types (Value Objects)

Prevent accidental ID mixing:

```typescript
const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
```

## General Rules

- Prefer `pipe` / `Effect.gen` generators over imperative chains
- No `any` types — use `unknown` + Schema decode
- No mutable global state — use Effect Ref or Context
- No barrel exports (`index.ts` re-exporting everything) — import directly
