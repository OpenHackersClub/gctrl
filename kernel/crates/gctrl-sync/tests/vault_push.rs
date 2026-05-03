//! End-to-end tests for `R2SyncEngine::push_vault`.
//!
//! `wiremock` stands in for R2's S3-compatible PUT endpoint — we point
//! the engine at the mock's URL and assert on what it does (which paths
//! get PUT, which get skipped, manifest persists, dry-run is no-op, etc.).

use std::fs;
use std::path::Path;

use duckdb::Connection;
use gctrl_sync::{
    vault::{VaultManifest, VaultSyncAction, VaultSyncOpts},
    R2SyncEngine,
};
use tempfile::TempDir;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn write(dir: &Path, rel: &str, content: &[u8]) {
    let abs = dir.join(rel);
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(abs, content).unwrap();
}

/// Build an `R2SyncEngine` whose `R2Client` is pointed at the wiremock
/// server. The DuckDB connection + sync_dir + workspace_id are immaterial
/// for vault sync (it touches none of them) but the constructor needs
/// concrete values.
fn engine_for(server: &MockServer, sync_dir: &Path) -> R2SyncEngine {
    let conn = Connection::open_in_memory().expect("duckdb in-memory");
    let mut config = gctrl_core::SyncConfig::default();
    config.r2_endpoint = server.uri();
    config.r2_bucket = "test-bucket".into();
    config.r2_access_key_id = "test-key".into();
    config.r2_secret_access_key = "test-secret".into();
    config.device_id = "test-device".into();
    R2SyncEngine::new(
        conn,
        config,
        sync_dir.to_path_buf(),
        "test-workspace".into(),
    )
}

#[tokio::test]
async fn push_uploads_new_files_and_writes_manifest() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/input/briefs/2026-05-03.md", b"# Daily brief\n");
    write(vault.path(), "UBER/input/raw/foo.md", b"# Foo");

    let engine = engine_for(&server, state.path());
    let result = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .expect("push_vault");

    assert_eq!(result.uploaded, 2);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.failed, 0);
    assert!(result.bytes_uploaded > 0);

    // Manifest should have both files now.
    let manifest = VaultManifest::load(state.path(), "UBER").unwrap();
    assert_eq!(manifest.entries.len(), 2);
    assert!(manifest.entries.contains_key("input/briefs/2026-05-03.md"));
    assert!(manifest.entries.contains_key("input/raw/foo.md"));
    assert!(manifest.updated_at.is_some());
}

#[tokio::test]
async fn push_skips_unchanged_files_via_manifest_dedup() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/x.md", b"unchanged");

    let engine = engine_for(&server, state.path());

    // First push uploads; second push (with no changes) must skip.
    let first = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(first.uploaded, 1);

    let second = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(second.uploaded, 0, "second push should dedup against manifest");
    assert_eq!(second.skipped, 1);
    assert_eq!(
        second.plan[0].action,
        VaultSyncAction::SkipHashMatch,
        "plan reflects the dedup"
    );
}

#[tokio::test]
async fn push_re_uploads_changed_files() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/x.md", b"v1");

    let engine = engine_for(&server, state.path());
    engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();

    // Modify content. Plan should mark it Upload and re-PUT.
    write(vault.path(), "UBER/x.md", b"v2 - meaningful edit");
    let result = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.uploaded, 1);
    assert_eq!(result.skipped, 0);

    let manifest = VaultManifest::load(state.path(), "UBER").unwrap();
    assert_eq!(manifest.entries.len(), 1);
}

#[tokio::test]
async fn dry_run_does_not_call_r2_or_write_manifest() {
    // No mock — if push tries to PUT, wiremock returns 404 and we'd see
    // a non-zero `failed` count, OR the test would 404-noise. Dry-run must
    // skip R2 entirely.
    let server = MockServer::start().await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/x.md", b"hello");

    let engine = engine_for(&server, state.path());
    let result = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts {
                dry_run: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(result.uploaded, 0);
    assert_eq!(result.failed, 0);
    // Plan still reflects what WOULD happen.
    assert_eq!(result.plan.len(), 1);
    assert_eq!(result.plan[0].action, VaultSyncAction::Upload);

    // No manifest file — dry-run is a no-op on disk.
    let manifest_path = VaultManifest::path(state.path(), "UBER");
    assert!(
        !manifest_path.exists(),
        "dry-run must not write the manifest"
    );
}

#[tokio::test]
async fn r2_failure_is_counted_per_file_not_fatal() {
    let server = MockServer::start().await;
    // R2 returns 503 — the engine logs + counts the failure but should not
    // bail out of the whole sync (next call retries the failed file).
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/x\.md$"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/y\.md$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/x.md", b"x");
    write(vault.path(), "UBER/y.md", b"y");

    let engine = engine_for(&server, state.path());
    let result = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();

    assert_eq!(result.uploaded, 1);
    assert_eq!(result.failed, 1);
    // Manifest has only the success — the 503 file isn't recorded.
    let manifest = VaultManifest::load(state.path(), "UBER").unwrap();
    assert_eq!(manifest.entries.len(), 1);
    assert!(manifest.entries.contains_key("y.md"));
    assert!(!manifest.entries.contains_key("x.md"));
}

#[tokio::test]
async fn force_re_uploads_even_when_hash_matches() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write(vault.path(), "UBER/x.md", b"unchanged");

    let engine = engine_for(&server, state.path());
    engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();

    let forced = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts {
                force: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(forced.uploaded, 1, "--force must re-upload despite hash match");
}

#[tokio::test]
async fn missing_project_subtree_is_not_an_error() {
    let server = MockServer::start().await;
    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    // No UBER/ directory created.

    let engine = engine_for(&server, state.path());
    let result = engine
        .push_vault(
            vault.path(),
            state.path(),
            "UBER",
            &[],
            VaultSyncOpts::default(),
        )
        .await
        .unwrap();
    assert!(result.plan.is_empty());
    assert_eq!(result.uploaded, 0);
}
