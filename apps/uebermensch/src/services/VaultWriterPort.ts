import { Context, type Effect, type Option } from "effect"
import type { VaultError, VaultSecretLeakError } from "../errors.js"

export type VaultEntry = {
  readonly path: string
  readonly mtime: Date
}

export type WrittenEntry = {
  readonly contentHash: string
}

export interface VaultWriterPortShape {
  /**
   * Write `content` to `path`, creating parent directories as needed.
   * Returns a SHA-256 content hash of the written bytes.
   *
   * May fail with `VaultSecretLeakError` when the `VaultSecretGuard`
   * middleware is in the Layer stack — callers must handle both error types.
   */
  readonly write: (
    path: string,
    content: string,
  ) => Effect.Effect<WrittenEntry, VaultError | VaultSecretLeakError>

  /**
   * Read the content at `path`. Returns `Option.none` if the path does not
   * exist; fails with `VaultError` only on hard I/O errors.
   */
  readonly read: (path: string) => Effect.Effect<Option.Option<string>, VaultError>

  /**
   * List entries whose path starts with `prefix`.
   *
   * **R2 write-cache requirement (blocker B5)**
   * R2 object listing is eventually consistent — a key uploaded seconds ago
   * may not appear in a subsequent `list` response. Adapters that use an
   * eventually-consistent store (R2, S3, GCS) MUST maintain an in-process map
   * of `{ path, mtime, putTimestamp }` entries populated on every `write` call
   * and merge those entries into the `list` result for at least 30 seconds
   * after each write. After the 30-second window the entry may be evicted from
   * the in-process cache on the assumption that the backing store has caught
   * up. Adapters backed by a strongly-consistent store (local filesystem,
   * DuckDB) are not required to maintain a write-cache; they may return list
   * results directly from the store.
   */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<VaultEntry>, VaultError>

  /**
   * Delete the file at `path`. A no-op (not an error) if the path does not
   * exist.
   */
  readonly delete: (path: string) => Effect.Effect<void, VaultError>
}

export class VaultWriterPort extends Context.Tag("uebermensch/VaultWriterPort")<
  VaultWriterPort,
  VaultWriterPortShape
>() {}
