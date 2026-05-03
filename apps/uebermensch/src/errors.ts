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
  // Hint from the upstream `Retry-After` header (or Anthropic's
  // `anthropic-ratelimit-*-reset`) for `rate_limited` failures. Schedule
  // wrappers honor this before falling back to exponential backoff.
  retryAfterMs: Schema.optional(Schema.Number),
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

export class ScheduleError extends Schema.TaggedError<ScheduleError>()("ScheduleError", {
  message: Schema.String,
  kind: Schema.Literal("config", "schema_invalid", "kernel_unreachable", "io_failure"),
}) {}

export class SecretsError extends Schema.TaggedError<SecretsError>()("SecretsError", {
  message: Schema.String,
  kind: Schema.Literal("unavailable", "permission_denied", "io_failure", "invalid_key"),
  key: Schema.optional(Schema.String),
}) {}

// Raised by VaultSecretGuard when a write would persist a recognized secret
// pattern to the vault. The `leaks` field carries one entry per matched
// pattern — multiple secrets in a single write each produce a separate entry.
export class VaultSecretLeakError extends Schema.TaggedError<VaultSecretLeakError>()(
  "VaultSecretLeakError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    leaks: Schema.Array(
      Schema.Struct({ name: Schema.String, matchedAt: Schema.Number }),
    ),
  },
) {}

// ---- Citation Mode v1 verifier errors (R3–R7) ----
// These are all fail-closed from day one except R3 (warn-only for 14 days
// after citation-mode v1 ships; the verifier wires the grace period externally).

/** R3 — a [[slug]] inside a brief/report/synthesis resolved to a source page.
 *  External sources must be cited via [n] + references[], not [[slug]]. */
export class SourceCitedInline extends Schema.TaggedError<SourceCitedInline>()(
  "SourceCitedInline",
  {
    message: Schema.String,
    slug: Schema.String,
    itemIndex: Schema.optional(Schema.Number),
    charOffset: Schema.optional(Schema.Number),
  },
) {}

/** R4 (missing variant) — a [n] marker in summary_md has no matching references[].n entry. */
export class ReferenceMissing extends Schema.TaggedError<ReferenceMissing>()(
  "ReferenceMissing",
  {
    message: Schema.String,
    n: Schema.Number,
    itemIndex: Schema.optional(Schema.Number),
  },
) {}

/** R4 (duplicate variant) — two or more references[] entries share the same n. */
export class ReferenceDuplicate extends Schema.TaggedError<ReferenceDuplicate>()(
  "ReferenceDuplicate",
  {
    message: Schema.String,
    n: Schema.Number,
    itemIndex: Schema.optional(Schema.Number),
  },
) {}

/** R5 — a references[] entry has no matching [n] marker in summary_md. */
export class ReferenceOrphan extends Schema.TaggedError<ReferenceOrphan>()(
  "ReferenceOrphan",
  {
    message: Schema.String,
    n: Schema.Number,
    itemIndex: Schema.optional(Schema.Number),
  },
) {}

/** R6 — references[].source_page_id does not resolve to a source page under input/raw/**. */
export class ReferenceSourceInvalid extends Schema.TaggedError<ReferenceSourceInvalid>()(
  "ReferenceSourceInvalid",
  {
    message: Schema.String,
    sourcePageId: Schema.String,
    n: Schema.optional(Schema.Number),
    itemIndex: Schema.optional(Schema.Number),
  },
) {}

/** R7 — references[].n values are not a contiguous 1-based sequence {1..len}. */
export class ReferenceSequenceInvalid extends Schema.TaggedError<ReferenceSequenceInvalid>()(
  "ReferenceSequenceInvalid",
  {
    message: Schema.String,
    itemIndex: Schema.optional(Schema.Number),
  },
) {}

// ---- NetService errors ----

/**
 * Raised by NetService methods when the upstream request fails.
 * Variants:
 *   - `unavailable`  — kernel daemon is down or `/api/net/*` route not yet deployed
 *   - `rate_limited` — upstream search/fetch provider is throttling
 *   - `not_found`    — 404 from the kernel route or the target URL
 *   - `invalid`      — bad request (malformed query, unsupported accept type, etc.)
 */
export class NetError extends Schema.TaggedError<NetError>()("NetError", {
  message: Schema.String,
  kind: Schema.Literal("unavailable", "rate_limited", "not_found", "invalid"),
  url: Schema.optional(Schema.String),
}) {}

// ---- FreshnessProbeService errors ----

/**
 * Raised by FreshnessProbeService when the probe stage itself fails unrecoverably.
 * Per-probe failures (net unavailable, LLM error) are handled gracefully inside
 * the service; ProbeError surfaces only when the top-level setup fails (e.g. the
 * directive cannot be parsed, or an unexpected internal error occurs).
 */
export class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
  kind: Schema.Literal("config", "llm_unavailable", "net_unavailable", "io_failure"),
}) {}
