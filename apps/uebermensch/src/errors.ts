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
}) {}
