---
title: Implementation — Vault File Sync (kernel `gctrl-sync` extension)
status: spec
related:
  - vault/specs/architecture/kernel/sync.md § 2.4
  - vault/specs/architecture/app-decoupling.md
---

# Vault File Sync — Kernel Implementation

This spec describes how the existing kernel `gctrl-sync` crate is extended to handle **app vault file payloads** alongside the telemetry-table payloads it already syncs. It is **not** a new driver / LKM — it adds methods to the existing `R2SyncEngine` and two new HTTP routes.

## Why this isn't a new driver

The kernel already has:

- `gctrl-sync::R2Client` — S3-compat PUT/GET/DELETE against R2 (`kernel/crates/gctrl-sync/src/r2.rs`).
- `gctrl-sync::R2SyncEngine` — push/pull manifest, status, scheduling (`kernel/crates/gctrl-sync/src/engine.rs`).
- `/api/sync/push` HTTP route — currently scoped to telemetry tables (`kernel/crates/gctrl-otel/src/receiver.rs`).
- `gctrl_vault_mounts` table — registry of per-app vaults the kernel watches.

Vault file sync uses *all* of these. A new driver crate would duplicate transport, auth, manifest, and OTel instrumentation that already exist. Per the [zero-duplication invariant](../../architecture/app-decoupling.md), vault file sync extends the existing crate.

## What goes away

`apps/uebermensch/src/adapters/R2Sync.ts` (247 LOC). Today this:

- walks `$UBER_VAULT_DIR` recursively
- SHA-256-hashes each file and dedupes against a manifest at `$UBER_VAULT_DIR/.uber-sync-state.json`
- shells out to `pnpm dlx wrangler@latest r2 object put` per uploaded file

After this spec lands, the same logic runs once inside `gctrl-sync`, against the kernel's already-configured R2 credentials, using the direct S3-compat client (no `wrangler` subprocess). The app's `R2Sync.ts` collapses into a thin `KernelR2Sync` Layer (~30 LOC) that POSTs `/api/sync/vault/push` through the kernel HTTP client.

## Surface area

### Crate API (Rust)

```rust
// kernel/crates/gctrl-sync/src/vault.rs (new)
pub struct VaultSyncPlanEntry {
    pub mount_name: String,
    pub rel_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub action: VaultSyncAction,  // Upload | Skip { reason: SkipReason }
}

pub struct VaultSyncResult {
    pub plan: Vec<VaultSyncPlanEntry>,
    pub uploaded: u64,
    pub skipped: u64,
    pub failed: u64,
    pub bytes_uploaded: u64,
    pub manifest_after: VaultManifest,
}

impl R2SyncEngine {
    /// Push every file under the vault mount to R2 vaults/{mount}/.
    /// Honors content_hash dedup (skip if remote sha matches manifest).
    /// `prefixes` narrows to subtrees (e.g. ["input/briefs", "input/raw"]).
    pub async fn push_vault(
        &self,
        mount_name: &str,
        prefixes: &[&str],
        opts: VaultSyncOpts,
    ) -> Result<VaultSyncResult, SyncError>;

    /// Pull from R2 vaults/{mount}/ into the local mount root.
    /// Atomic file writes (tmp+rename). Returns the same VaultSyncResult shape.
    pub async fn pull_vault(
        &self,
        mount_name: &str,
        prefixes: &[&str],
        opts: VaultSyncOpts,
    ) -> Result<VaultSyncResult, SyncError>;
}

pub struct VaultSyncOpts {
    pub dry_run: bool,
    pub force: bool,        // re-upload even if hash matches
    pub concurrency: usize, // default 8
}
```

### HTTP routes

Mounted alongside the existing `/api/sync/push` in `gctrl-otel::receiver`:

| Route | Verb | Purpose |
|---|---|---|
| `/api/sync/vault/push` | POST | Push the named vault mount's files to R2 |
| `/api/sync/vault/pull` | POST | Pull the named vault mount's files from R2 |
| `/api/sync/vault/status` | GET | Query last-pushed sha + manifest state for a mount |

Request body for push/pull:

```json
{
  "mount_name": "uber",
  "prefixes": ["input/briefs", "input/raw", "input/wiki"],
  "dry_run": false,
  "force": false
}
```

Response (success):

```json
{
  "uploaded": 12,
  "skipped": 84,
  "failed": 0,
  "bytes_uploaded": 245100,
  "plan": [
    { "rel_path": "input/briefs/2026-05-03.md", "sha256": "…", "action": "upload" },
    { "rel_path": "input/raw/2026-05-02--foo.md", "sha256": "…", "action": "skip", "reason": "hash_match" }
  ]
}
```

Errors map per [`sync.md § 11`](../../architecture/kernel/sync.md#11-error-handling) (HTTP 503 when sync isn't configured; 404 for unknown mount; 502 for R2 failures).

### Manifest

Per-mount manifest at `~/.local/share/gctrl/sync/vaults/{mount-name}.json`:

```json
{
  "version": 1,
  "mount_name": "uber",
  "updated_at": "2026-05-03T12:00:00Z",
  "entries": {
    "input/briefs/2026-05-03.md": {
      "sha256": "abcd…",
      "size_bytes": 18402,
      "uploaded_at": "2026-05-03T12:00:01Z",
      "etag": "<r2 etag>"
    }
  }
}
```

Atomic write (tmp+rename), same pattern as the existing telemetry manifest. Manifest path is *kernel-owned*, not under the app's vault — replaces the in-vault `.uber-sync-state.json` that today pollutes the app's filesystem.

## Auth + configuration

Reuses the existing `SyncConfig` (R2 credentials are kernel-resolved, not per-app). Apps never see R2 credentials — the kernel injects them into the `R2Client`. This matches the [external-API rule in os.md](../../architecture/os.md#dependency-direction-invariant): apps and shell MUST NOT hold cloud credentials.

If `SyncConfig` is `None`, the routes return `503 sync_not_configured` so the app can degrade gracefully (same shape as `/api/sync/push` today).

## Implementation notes

1. **Reuse `R2Client::upload_file`** for the actual PUT. It already handles retry, content-type, and error mapping. Adding `If-None-Match` dedup is a small extension to that method.
2. **Walk strategy**: `walkdir` crate (already a transitive dep) bounded by `prefixes`. Skip dotfiles + the manifest itself.
3. **Concurrency**: bounded `tokio::task::JoinSet` (default 8). Don't spam R2 with hundreds of parallel PUTs.
4. **Hashing**: streaming SHA-256 (don't load whole files). For ≤16 MB files, `tokio::fs::read` + `Sha256::digest` is fine; for larger, stream.
5. **No DuckDB writes**: vault-sync state lives in the JSON manifest, not in DuckDB. Vault contents themselves are content-addressable and don't need a relational index.
6. **OTel spans**: wrap each push/pull in a span (`sync.vault.push`, `sync.vault.pull`) with attributes `mount_name`, `uploaded`, `bytes`. Reuses the existing kernel telemetry pipeline.

## Test plan

- `kernel/crates/gctrl-sync/src/vault.rs` unit tests with `tempfile::TempDir` for the local vault and an in-process R2 mock (e.g. `wiremock`).
- `gctrl-otel::receiver` integration test for `/api/sync/vault/push` — `tower::ServiceExt::oneshot` with a stub `R2SyncEngine` that returns a known plan.
- App side: replace `apps/uebermensch/tests/sync.test.ts` (4 tests covering manifest dedup) with a much smaller test that mocks the kernel HTTP response — the dedup logic moves into the kernel suite.

## Migration path

1. **Land the kernel extension** (`push_vault` / `pull_vault` + HTTP routes + tests) — non-breaking; the existing `/api/sync/push` keeps working.
2. **Replace the app's `R2Sync.ts`** with `KernelR2Sync.ts` that calls `/api/sync/vault/push`. Net –217 LOC in the app.
3. **Move the in-vault manifest** out of `$UBER_VAULT_DIR/.uber-sync-state.json` into the kernel's `~/.local/share/gctrl/sync/vaults/uber.json`. One-shot migration on first run: read the old file, write the new one, delete the old.
4. **Remove `wrangler` from the app's runtime path** — it's no longer needed for sync. (Build-time wrangler for Worker deploys stays.)

## Out of scope

- **D1 sync** (the existing `/api/sync/push` SQLite→D1 path). Vault sync is filesystem→R2 only.
- **Conflict resolution beyond hash-equality**. Two devices writing the same vault path with different bytes is a human-coordination concern; the manifest records what each device pushed and a future `--strategy=…` flag can pick a winner. Out of scope for v1.
- **Selective sync** finer-grained than `prefixes` (no glob support yet — adds complexity, defer until needed).

## Why this completes the eject path for vault sync

Per [App ↔ Kernel Decoupling § Worked Example](../../architecture/app-decoupling.md#worked-example--uebermensch), the "vault filesystem write" capability has both a kernel default (`FileSystemVault` + watcher index) and an ejection seam (`VaultWriterPort` for user-supplied alternatives). Vault *sync* (push to remote object store) is exactly the same shape: kernel default lives in `gctrl-sync`, ejection is "user wires a different `SyncService` Layer that talks to whatever blob store the host provides."

The app keeps its `SyncService` port. The default Layer binds it to the kernel's HTTP `/api/sync/vault/*` routes. Done.
