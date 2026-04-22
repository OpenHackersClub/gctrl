import { Context, type Effect } from "effect"
import { Schema } from "effect"

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
  message: Schema.String,
  kind: Schema.Literal("config", "unreachable", "io_failure", "invalid"),
  key: Schema.optional(Schema.String),
}) {}

export type SyncPlanEntry = {
  readonly absPath: string
  readonly key: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly action: "upload" | "skip"
  readonly remoteSha256: string | null
}

export type SyncResult = {
  readonly uploaded: number
  readonly skipped: number
  readonly failed: number
  readonly entries: ReadonlyArray<SyncPlanEntry>
}

export type SyncInput = {
  readonly vaultDir: string
  readonly prefixes: ReadonlyArray<string>
  readonly dryRun: boolean
  // When true, bypass the local sha256 manifest and re-upload every file.
  readonly force?: boolean
}

export interface SyncServiceShape {
  readonly run: (input: SyncInput) => Effect.Effect<SyncResult, SyncError>
}

export class SyncService extends Context.Tag("uebermensch/SyncService")<
  SyncService,
  SyncServiceShape
>() {}
