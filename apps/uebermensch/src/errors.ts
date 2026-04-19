import { Schema } from "effect"

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

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
