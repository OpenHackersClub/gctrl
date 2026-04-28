# Applications Style Guide (Effect-TS — `apps/`)

The rules below are enforced via review and the ripgrep sweep documented
in `vault/specs/principles.md` § Effect-TS Invariants. Each rule shows
**Bad** (what the audit caught in this repo) and **Good** (the idiomatic
fix) so reviewers can pattern-match.

## Tag Access

Never access `._tag` directly. Use proper combinators:

- `Effect.catchTag` / `Effect.catchTags` for error handling
- `Match.tag` + `Match.exhaustive` for pattern matching
- `Schema.TaggedError` / `Schema.TaggedClass` for defining tagged types
- `Exit.match`, `Either.match`, `Option.match` for branching

**Bad:**
```typescript
const seed = fromSeed._tag === "Some" ? resolve(fromSeed.value) : FIXTURE_ROOT
```

**Good:**
```typescript
const seed = Option.match(fromSeed, {
  onSome: (v) => resolve(v),
  onNone: () => FIXTURE_ROOT,
})
```

## Tagged Errors (no bare `new Error`)

Define domain errors as `Schema.TaggedError` with structured fields.
Inside an Effect context, **never** `Effect.fail(new Error(...))` and
**never** `throw new Error(...)` from a function the Effect runtime
will wrap.

**Bad:**
```typescript
yield* Effect.fail(new Error(`${issues.length} validation issue(s)`))
// or
catch: (e) => new Error(String(e))
// or, inside a sync helper called from an Effect:
if (Number.isNaN(d.getTime())) throw new Error(`invalid starts_at: ${startsAt}`)
```

**Good:**
```typescript
class ProfileError extends Schema.TaggedError<ProfileError>()(
  "ProfileError",
  { message: Schema.String, issues: Schema.optional(Schema.Array(Schema.String)) }
) {}

yield* Effect.fail(new ProfileError({
  message: `${issues.length} validation issue(s)`, issues,
}))

// For sync helpers, return Either instead of throwing:
const datePart = (s: string): Either.Either<string, string> =>
  Number.isNaN(new Date(s).getTime())
    ? Either.left(`invalid starts_at: ${s}`)
    : Either.right(/* … */)
```

## Decode External JSON (no `as any`)

HTTP / kernel responses MUST flow through `Schema.decodeUnknown` so a
malformed payload becomes a tagged error, not a runtime
`cannot read property of undefined`. The wire schema is local to the
adapter; the domain type is what the rest of the codebase sees.

**Bad:**
```typescript
const mapIssue = (raw: any): Issue => ({ id: raw.id, projectId: raw.project_id, /* … */ })
const issues = (raw as any[]).map(mapIssue)
const envelope = raw as { issue: unknown }
```

**Good:**
```typescript
const KernelIssue = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  status: IssueStatus,
  /* … */
})
const decodeIssue = (raw: unknown, ctx: string) =>
  Schema.decodeUnknown(KernelIssue)(raw).pipe(
    Effect.map(toIssue),
    Effect.mapError((e) => new KernelError({
      message: `${ctx}: invalid kernel response — ${String(e)}`,
    })),
  )
```

## No Barrel Re-exports

Wildcard re-exports defeat tree-shaking and let new internal symbols
silently leak into the package's public API. List exports explicitly.

**Bad:**
```typescript
// src/schema/index.ts
export * from "./Issue.js"
export * from "./IssueEvent.js"
export * from "./Board.js"
```

**Good:**
```typescript
// src/schema/index.ts
export {
  Assignee, AssigneeType, CreateIssueInput, Issue,
  IssueFilter, IssueId, IssueStatus, Priority, ProjectId,
} from "./Issue.js"
export { Comment, IssueEvent, IssueEventType } from "./IssueEvent.js"
export { Board, BoardId, Project } from "./Board.js"
```

When in doubt, prefer importing directly from the leaf module — barrels
are only justified when a package has a deliberate, curated public API.

## No Dynamic `require` Inside Effect

Dynamic `require()` defeats bundlers and obscures the dependency graph.
Use a static `import` and wrap the call site in `Effect.try` (or
`Effect.sync` for code that cannot throw).

**Bad:**
```typescript
const { readFileSync } = yield* Effect.sync(() => require("node:fs"))
let content: string
try {
  content = readFileSync(filePath, "utf-8")
} catch {
  yield* Console.error(`Cannot read file: ${filePath}`)
  return
}
```

**Good:**
```typescript
import { readFileSync } from "node:fs"

const maybeContent = yield* Effect.try(() => readFileSync(filePath, "utf-8")).pipe(
  Effect.option,
)
if (Option.isNone(maybeContent)) {
  yield* Console.error(`Cannot read file: ${filePath}`)
  return
}
const content = maybeContent.value
```

## Recover with `catchTag`, not `catchAll`

`Effect.catchAll((e) => …)` swallows the error type and lands `e` as
`unknown`. Use `Effect.catchTag(<TagName>, …)` so the recovered error
is statically known. Reserve `catchAll` for top-level entrypoints where
the program is about to exit.

**Bad:**
```typescript
return runWork().pipe(
  Effect.catchAll((e) => Console.error(`Error: ${e}`))
)
```

**Good:**
```typescript
class ExecError extends Schema.TaggedError<ExecError>()(
  "ExecError",
  { message: Schema.String, bin: Schema.String, args: Schema.Array(Schema.String) }
) {}

return runWork().pipe(
  Effect.catchTag("ExecError", (e) =>
    Console.error(`Error: ${e.message}. Is ${e.bin} installed?`)
  )
)
```

## Service Definitions (Ports as `Context.Tag`)

Model service ports as `Context.Tag`. Each method returns `Effect` with
typed errors:

```typescript
class BoardService extends Context.Tag("BoardService")<
  BoardService,
  {
    readonly createIssue: (input: CreateIssueInput) => Effect.Effect<Issue, BoardError>
    readonly moveIssue: (id: IssueId, status: IssueStatus) =>
      Effect.Effect<Issue, BoardError | IssueNotFoundError>
  }
>() {}
```

## Layer Composition

Wire adapters via Effect Layers at the entrypoint, keeping domain logic
pure. Centralize repeated layer wiring in a `provideAllLayers(...)`
factory rather than re-pasting the same `Effect.provide(...)` chain in
every command.

## Branded Types (Value Objects)

Prevent accidental ID mixing:

```typescript
const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
```

## General Rules

- Prefer `pipe` / `Effect.gen` generators over imperative chains.
- No `any` types — use `unknown` + Schema decode (see above).
- No mutable global state — use `Effect.Ref` or `Context`.
- No barrel exports — list each name explicitly (see above).
- Imperative loops mutating shared state (e.g. a worker pool with
  `let next = 0`) MUST be replaced with `Effect.forEach(items, fn,
  { concurrency })` + `Ref` for accumulators.
