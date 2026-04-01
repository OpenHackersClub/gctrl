import { Schema } from "effect"

export class KernelError extends Schema.TaggedError<KernelError>()(
  "KernelError",
  { message: Schema.String, statusCode: Schema.optional(Schema.Number) }
) {}

export class KernelUnavailableError extends Schema.TaggedError<KernelUnavailableError>()(
  "KernelUnavailableError",
  { message: Schema.String }
) {}
