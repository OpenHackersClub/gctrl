use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use gctrl_otel::disk_usage::{docker_root_is_allowed, remove_candidate, scan_roots};
use std::fs;
use tower::ServiceExt;

#[test]
fn scan_only_reports_build_artifacts_inside_allowed_roots() {
    let allowed = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    fs::create_dir_all(allowed.path().join("project/target/debug")).unwrap();
    fs::write(
        allowed.path().join("project/Cargo.toml"),
        "[package]\nname = \"example\"\nversion = \"0.1.0\"",
    )
    .unwrap();
    fs::write(
        allowed.path().join("project/target/debug/app"),
        vec![0_u8; 4096],
    )
    .unwrap();
    fs::create_dir_all(allowed.path().join("project/src")).unwrap();
    fs::write(allowed.path().join("project/src/main.rs"), "fn main() {}").unwrap();
    fs::create_dir_all(other.path().join("target")).unwrap();

    let report = scan_roots(&[allowed.path().to_path_buf()]).unwrap();
    assert_eq!(report.roots.len(), 1);
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(
        report.candidates[0].path,
        allowed
            .path()
            .join("project/target")
            .canonicalize()
            .unwrap()
    );
    assert!(report.candidates[0].bytes >= 4096);
    assert!(!report.candidates[0].path.starts_with(other.path()));
}

#[test]
fn removal_rejects_root_source_tree_and_symlink_escape() {
    let allowed = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    fs::create_dir_all(allowed.path().join("src")).unwrap();
    fs::create_dir_all(allowed.path().join("target")).unwrap();
    fs::write(
        allowed.path().join("Cargo.toml"),
        "[package]\nname = \"example\"\nversion = \"0.1.0\"",
    )
    .unwrap();
    fs::write(allowed.path().join("target/file"), "build").unwrap();
    fs::create_dir_all(other.path().join("target")).unwrap();
    let roots = [allowed.path().to_path_buf()];

    assert!(remove_candidate(&roots, allowed.path()).is_err());
    assert!(remove_candidate(&roots, &allowed.path().join("src")).is_err());
    assert!(remove_candidate(&roots, &other.path().join("target")).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            other.path().join("target"),
            allowed.path().join("project-target"),
        )
        .unwrap();
        assert!(remove_candidate(&roots, &allowed.path().join("project-target")).is_err());
    }
    remove_candidate(&roots, &allowed.path().join("target")).unwrap();
    assert!(!allowed.path().join("target").exists());
    assert!(other.path().join("target").exists());
}

#[test]
fn docker_root_requires_a_real_host_path_inside_the_allowlist() {
    let allowed = tempfile::tempdir().unwrap();
    let docker = allowed.path().join("docker");
    fs::create_dir(&docker).unwrap();
    let roots = [allowed.path().to_path_buf()];
    assert!(docker_root_is_allowed(&roots, &docker));
    assert!(!docker_root_is_allowed(&[], &docker));
    assert!(!docker_root_is_allowed(
        &roots,
        std::path::Path::new("/var/lib/docker")
    ));
}

#[test]
fn cargo_pool_slot_is_suggested_only_while_unlocked() {
    let temp = tempfile::tempdir().unwrap();
    let pool = temp.path().join("cargo-target/repo-123");
    fs::create_dir_all(pool.join("slot-0")).unwrap();
    fs::write(pool.join("slot-0/app"), vec![0_u8; 128]).unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(pool.join("slot-0.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let roots = [temp.path().join("cargo-target")];
    assert!(scan_roots(&roots).unwrap().candidates.is_empty());
    assert!(remove_candidate(&roots, &pool.join("slot-0")).is_err());
    lock.unlock().unwrap();
    assert_eq!(scan_roots(&roots).unwrap().candidates.len(), 1);
    remove_candidate(&roots, &pool.join("slot-0")).unwrap();
}

#[tokio::test]
async fn disk_routes_require_configured_paths_for_removal() {
    let app = gctrl_otel::create_router(gctrl_storage::DuckDbStore::open(":memory:").unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/disk/usage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/disk/candidates/remove")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"path":"/definitely-outside/target"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status() == StatusCode::FORBIDDEN || response.status() == StatusCode::NOT_FOUND
    );
}
