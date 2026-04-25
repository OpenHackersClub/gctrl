import { Effect, Schema } from "effect"

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  kind: Schema.optional(
    Schema.Literal("not_found", "collision", "io_failure", "parse_failure"),
  ),
}) {}

// Wrap a node:fs (or similar) Promise call as an Effect that fails with a
// VaultError. Eliminates ~6 lines of catch-and-construct boilerplate per call site.
export const vaultIo = <T>(
  fn: () => Promise<T>,
  opts: {
    readonly message: string | ((e: unknown) => string)
    readonly path?: string
    readonly kind?: "not_found" | "collision" | "io_failure" | "parse_failure"
  },
): Effect.Effect<T, VaultError> =>
  Effect.tryPromise({
    try: fn,
    catch: (e) =>
      new VaultError({
        message:
          typeof opts.message === "function"
            ? opts.message(e)
            : `${opts.message}: ${String(e)}`,
        path: opts.path,
        kind: opts.kind ?? "io_failure",
      }),
  })

export class ProfileError extends Schema.TaggedError<ProfileError>()("ProfileError", {
  message: Schema.String,
  issues: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class LlmError extends Schema.TaggedError<LlmError>()("LlmError", {
  message: Schema.String,
  kind: Schema.optional(
    Schema.Literal("unavailable", "rate_limited", "budget_exceeded", "invalid"),
  ),
}) {}

export class CitationError extends Schema.TaggedError<CitationError>()("CitationError", {
  message: Schema.String,
  kind: Schema.Literal("typed_prefix", "unresolved", "fabricated_source"),
  link: Schema.optional(Schema.String),
  itemIndex: Schema.optional(Schema.Number),
}) {}

export class IngestError extends Schema.TaggedError<IngestError>()("IngestError", {
  message: Schema.String,
  kind: Schema.Literal("fetch_failed", "extract_failed", "low_quality", "collision", "io_failure"),
  url: Schema.optional(Schema.String),
}) {}

export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
  message: Schema.String,
  channel: Schema.optional(Schema.String),
  driver: Schema.optional(Schema.String),
  kind: Schema.Literal("config", "unreachable", "rate_limited", "invalid", "io_failure"),
  status: Schema.optional(Schema.Number),
}) {}
