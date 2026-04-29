import { Schema } from "effect"

export class KernelError extends Schema.TaggedError<KernelError>()(
  "KernelError",
  { message: Schema.String, statusCode: Schema.optional(Schema.Number) }
) {}

export class KernelUnavailableError extends Schema.TaggedError<KernelUnavailableError>()(
  "KernelUnavailableError",
  { message: Schema.String }
) {}

// Failure of a subprocess invoked by the shell (e.g. `gctrl net fetch`).
export class ExecError extends Schema.TaggedError<ExecError>()(
  "ExecError",
  {
    message: Schema.String,
    bin: Schema.String,
    args: Schema.Array(Schema.String),
    output: Schema.optional(Schema.String),
  }
) {}

// Failure of a quality-gate audit check (build/lint/tests/acceptance).
export class AuditError extends Schema.TaggedError<AuditError>()(
  "AuditError",
  {
    message: Schema.String,
    failed: Schema.Number,
    passed: Schema.Number,
  }
) {}
