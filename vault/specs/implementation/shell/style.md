# Shell Style Guide (Effect-TS — `shell/gctrl-shell/`)

The shell is an `@effect/cli` program. Most rules from
`vault/specs/implementation/apps/style.md` apply verbatim — this file
captures the shell-specific specializations.

## All Apps Rules Apply

Read `apps/style.md` first. Every rule there (no `._tag`, tagged errors
over bare `new Error`, `Schema.decodeUnknown` over `as any`, no barrel
re-exports, no dynamic `require`, `catchTag` over `catchAll`) applies
to commands, adapters, and services in `shell/gctrl-shell/src/`.

## KernelClient is the Only HTTP Adapter

Commands MUST NOT call `fetch` directly. Use the `KernelClient` service
port:

```typescript
const cmd = Command.make("foo", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const data = yield* kernel.get("/api/foo", FooSchema)
    yield* Console.log(data.bar)
  })
)
```

Tests inject a mock `KernelClient` Layer (see
`test/helpers/mock-kernel.ts`) — there is no real HTTP in unit tests.

## External APIs Go Through Kernel Drivers

The shell MUST NOT depend on `ccli`, `gh`, `linear-cli`, or call
GitHub / Linear / Slack APIs directly. All external access goes through
kernel driver routes (`/api/github/*`, `/api/linear/*`, …) so
authentication and rate-limiting are centralized.

The one carve-out is the `gctrl` Rust binary for filesystem-backed
spider operations (`net fetch/crawl/list/show/compact`). That call
SHOULD use the typed `ExecError` pattern below, not bare `new Error`.

## Subprocess Calls Use `ExecError`

When the shell shells out (e.g. invoking the `gctrl` Rust binary),
failure MUST surface as a tagged `ExecError`, not a bare Error.

**Bad:**
```typescript
if (!result.ok) {
  return yield* Effect.fail(new Error(`gctrl ${args[0]} failed`))
}
```

**Good:**
```typescript
import { ExecError } from "../errors"

if (!result.ok) {
  return yield* Effect.fail(new ExecError({
    message: `gctrl ${args[0]} failed`,
    bin: GCTRL_BIN,
    args,
    output: result.output,
  }))
}
```

Recovery uses `Effect.catchTag("ExecError", …)` so the error fields are
statically available to the handler.

## Optional Args: `Option.match`, not `._tag`

`@effect/cli` `Options.optional()` returns an `Option`. Branch with
`Option.match` / `Option.isSome` / `Option.getOrElse` — never
`opt._tag === "Some"`.

**Bad:**
```typescript
const seed = fromSeed._tag === "Some" ? resolve(fromSeed.value) : DEFAULT
```

**Good:**
```typescript
const seed = Option.match(fromSeed, {
  onSome: (v) => resolve(v),
  onNone: () => DEFAULT,
})
```

## File I/O: Static Import + `Effect.try`

The `node:fs` builtins MUST be imported statically. Wrap the call in
`Effect.try` and recover with `Option`/`Either` rather than imperative
`try/catch`.

**Bad:**
```typescript
const { readFileSync } = yield* Effect.sync(() => require("node:fs"))
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

const maybe = yield* Effect.try(() => readFileSync(filePath, "utf-8")).pipe(
  Effect.option,
)
if (Option.isNone(maybe)) {
  yield* Console.error(`Cannot read file: ${filePath}`)
  return
}
const content = maybe.value
```

## Quality Gate: `AuditError` for the audit command

The `audit` command MUST fail with a tagged `AuditError` carrying
structured `{ failed, passed }` counts so callers (CI scripts, skills)
can branch on the structured fields rather than parse a stringified
message.

## Test Helpers

Mock `KernelClient` factories live in `test/helpers/mock-kernel.ts`.
Per-command tests SHOULD reuse the shared factory rather than spinning
up bespoke `Layer.succeed` blocks. New mock helpers MUST be exported
from that file (no barrel re-exports — list them explicitly).
