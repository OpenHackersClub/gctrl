//! HTTP contract tests for `/api/sync/vault/{push,status}`.
//!
//! Wires the kernel router with a `TempDir` vault root + a `TempDir`
//! state dir + an R2Client pointed at a `wiremock` PUT endpoint. Asserts
//! the routes correctly:
//!   - 503 when sync isn't configured / vault root not set
//!   - 404 when the project_key isn't a registered vault mount
//!   - 200 happy-path push that uploads files + writes manifest
//!   - 200 status returns the persisted manifest
//!   - dry_run skips R2 + manifest write
//!   - per-file R2 failures are counted, not fatal

use std::sync::Arc;

use axum::body::Body;
use chrono::Utc;
use gctrl_otel::create_router_full_with_vault;
use gctrl_storage::{DuckDbStore, SqliteStore};
use http::Request;
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn write(dir: &std::path::Path, rel: &str, content: &[u8]) {
    let abs = dir.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(abs, content).unwrap();
}

fn register_mount(sqlite: &Arc<SqliteStore>, project_key: &str) {
    let now = Utc::now();
    sqlite
        .create_vault_mount(&gctrl_core::VaultMount {
            id: uuid::Uuid::new_v4().to_string(),
            name: project_key.to_string(),
            root_path: project_key.to_string(),
            kind: gctrl_core::VaultMountKind::App,
            git_url: None,
            app_id: Some("test-app".into()),
            last_commit_sha: None,
            last_synced_at: None,
            created_at: now,
            updated_at: now,
        })
        .unwrap();
}

struct Fixtures {
    router: axum::Router,
    vault: TempDir,
    /// Held to keep the state-dir TempDir alive for the duration of the test
    /// (the router's `state_dir` points inside it). Read elsewhere via
    /// `f.router`'s captured Arc<AppState>.
    #[allow(dead_code)]
    state: TempDir,
}

fn build_app(server_uri: &str, register: &[&str]) -> Fixtures {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    for k in register {
        register_mount(&sqlite, k);
    }
    let mut sync_config = gctrl_core::SyncConfig::default();
    sync_config.r2_endpoint = server_uri.to_string();
    sync_config.r2_bucket = "test-bucket".into();
    sync_config.r2_access_key_id = "test-key".into();
    sync_config.r2_secret_access_key = "test-secret".into();
    sync_config.device_id = "test-device".into();

    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let router = create_router_full_with_vault(
        store,
        sqlite,
        Some(Arc::new(sync_config)),
        Arc::new(gctrl_core::NetConfig::default()),
        Arc::new(gctrl_core::SchedulerConfig::default()),
        Some(vault.path().to_path_buf()),
        Some(state.path().to_path_buf()),
    );
    Fixtures { router, vault, state }
}

async fn post_push(
    router: &axum::Router,
    body: Value,
) -> http::Response<Body> {
    let req = Request::builder()
        .method("POST")
        .uri("/api/sync/vault/push")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    router.clone().oneshot(req).await.unwrap()
}

#[tokio::test]
async fn push_503_when_sync_not_configured() {
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    register_mount(&sqlite, "UBER");
    let vault = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    // No sync_config — route must fail closed.
    let router = create_router_full_with_vault(
        store,
        sqlite,
        None,
        Arc::new(gctrl_core::NetConfig::default()),
        Arc::new(gctrl_core::SchedulerConfig::default()),
        Some(vault.path().to_path_buf()),
        Some(state.path().to_path_buf()),
    );

    let resp = post_push(
        &router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::SERVICE_UNAVAILABLE);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&body);
    assert!(msg.contains("R2 sync not configured"), "got: {msg}");
}

#[tokio::test]
async fn push_503_when_vault_root_not_set() {
    let server = MockServer::start().await;
    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
    register_mount(&sqlite, "UBER");
    let mut sync_config = gctrl_core::SyncConfig::default();
    sync_config.r2_endpoint = server.uri();
    sync_config.r2_bucket = "test-bucket".into();
    sync_config.r2_access_key_id = "k".into();
    sync_config.r2_secret_access_key = "s".into();
    let state = TempDir::new().unwrap();

    let router = create_router_full_with_vault(
        store,
        sqlite,
        Some(Arc::new(sync_config)),
        Arc::new(gctrl_core::NetConfig::default()),
        Arc::new(gctrl_core::SchedulerConfig::default()),
        None, // no vault root
        Some(state.path().to_path_buf()),
    );
    let resp = post_push(
        &router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::SERVICE_UNAVAILABLE);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&body);
    assert!(msg.contains("vault root not configured"), "got: {msg}");
}

#[tokio::test]
async fn push_404_when_project_key_unregistered() {
    let server = MockServer::start().await;
    // No mounts registered.
    let f = build_app(&server.uri(), &[]);
    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "GHOST" }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::NOT_FOUND);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&body);
    assert!(msg.contains("GHOST"), "got: {msg}");
}

#[tokio::test]
async fn push_uploads_files_and_persists_manifest() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let f = build_app(&server.uri(), &["UBER"]);
    write(f.vault.path(), "UBER/input/briefs/2026-05-03.md", b"# Daily brief\n");
    write(f.vault.path(), "UBER/input/raw/foo.md", b"# Foo");

    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["project_key"], "UBER");
    assert_eq!(v["uploaded"], 2);
    assert_eq!(v["failed"], 0);
    assert!(v["bytes_uploaded"].as_u64().unwrap() > 0);
    let plan = v["plan"].as_array().unwrap();
    assert_eq!(plan.len(), 2);

    // Status route now returns the manifest with the two entries.
    let req = Request::builder()
        .uri("/api/sync/vault/status?project_key=UBER")
        .body(Body::empty())
        .unwrap();
    let resp = f.router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let m: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(m["project_key"], "UBER");
    let entries = m["entries"].as_object().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.contains_key("input/briefs/2026-05-03.md"));
    assert!(entries.contains_key("input/raw/foo.md"));
}

#[tokio::test]
async fn dry_run_does_not_write_manifest() {
    let server = MockServer::start().await;
    // No PUT handlers — if dry_run leaks through, wiremock 404s and `failed`
    // bumps. The test asserts `failed == 0` to catch that.
    let f = build_app(&server.uri(), &["UBER"]);
    write(f.vault.path(), "UBER/x.md", b"hello");

    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "UBER", "dry_run": true }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["uploaded"], 0);
    assert_eq!(v["failed"], 0);
    let plan = v["plan"].as_array().unwrap();
    assert_eq!(plan.len(), 1);

    // Status should still be empty — manifest never persisted.
    let req = Request::builder()
        .uri("/api/sync/vault/status?project_key=UBER")
        .body(Body::empty())
        .unwrap();
    let resp = f.router.clone().oneshot(req).await.unwrap();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let m: Value = serde_json::from_slice(&body).unwrap();
    let entries = m["entries"].as_object().unwrap();
    assert!(entries.is_empty(), "dry-run must not write manifest entries");
}

#[tokio::test]
async fn second_push_dedups_via_manifest() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"^/test-bucket/vaults/UBER/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let f = build_app(&server.uri(), &["UBER"]);
    write(f.vault.path(), "UBER/x.md", b"unchanged");

    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["uploaded"], 1);

    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["uploaded"], 0, "second push should dedup");
    assert_eq!(v["skipped"], 1);
}

#[tokio::test]
async fn r2_failure_per_file_is_counted_not_fatal() {
    let server = MockServer::start().await;
    // x.md → 503; y.md → 200.
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

    let f = build_app(&server.uri(), &["UBER"]);
    write(f.vault.path(), "UBER/x.md", b"x");
    write(f.vault.path(), "UBER/y.md", b"y");

    let resp = post_push(
        &f.router,
        serde_json::json!({ "project_key": "UBER" }),
    )
    .await;
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["uploaded"], 1);
    assert_eq!(v["failed"], 1);
}

#[tokio::test]
async fn status_404_for_unregistered_project_key() {
    let server = MockServer::start().await;
    let f = build_app(&server.uri(), &[]);
    let req = Request::builder()
        .uri("/api/sync/vault/status?project_key=GHOST")
        .body(Body::empty())
        .unwrap();
    let resp = f.router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), http::StatusCode::NOT_FOUND);
}
