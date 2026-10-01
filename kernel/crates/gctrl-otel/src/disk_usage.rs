//! Read and remove recognized build outputs under explicit operator-approved roots.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use axum::{extract::State, http::StatusCode, Json};
use cap_std::ambient_authority;
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};

use crate::receiver::AppState;
use std::sync::Arc;

#[derive(Debug, Serialize)]
pub struct DiskCandidate {
    pub path: PathBuf,
    pub bytes: u64,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct DiskRoot {
    pub path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct DiskReport {
    pub roots: Vec<DiskRoot>,
    pub candidates: Vec<DiskCandidate>,
}

#[derive(Debug, Deserialize)]
pub struct RemoveRequest {
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct DockerCandidate {
    pub id: String,
    pub bytes: u64,
    pub description: String,
    pub reclaimable: bool,
}

#[derive(Debug, Serialize)]
pub struct DockerReport {
    pub available: bool,
    pub reason: Option<String>,
    pub candidates: Vec<DockerCandidate>,
}

#[derive(Debug, Deserialize)]
pub struct PruneRequest {
    pub id: String,
}

fn candidate_kind(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    let parent = path.parent()?;
    match name {
        "target" if parent.join("Cargo.toml").is_file() => Some("Rust build"),
        ".next" if parent.join("package.json").is_file() => Some("Next.js build"),
        ".turbo" if parent.join("package.json").is_file() => Some("Turborepo cache"),
        ".gradle"
            if parent.join("build.gradle").is_file()
                || parent.join("build.gradle.kts").is_file() =>
        {
            Some("Gradle cache")
        }
        "dist" if parent.join("package.json").is_file() => Some("Distribution build"),
        "build"
            if parent.join("package.json").is_file()
                || parent.join("build.gradle").is_file()
                || parent.join("build.gradle.kts").is_file() =>
        {
            Some("Build output")
        }
        "out" if parent.join("package.json").is_file() => Some("Build output"),
        ".cache"
            if parent.file_name()?.to_str()? == "node_modules"
                && parent.parent()?.join("package.json").is_file() =>
        {
            Some("Package build cache")
        }
        _ if cargo_pool_slot(path) => Some("Cargo pooled build"),
        _ => None,
    }
}

fn cargo_pool_slot(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(index) = name.strip_prefix("slot-") else {
        return false;
    };
    !index.is_empty()
        && index.bytes().all(|byte| byte.is_ascii_digit())
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("cargo-target")
}

fn lock_cargo_slot(root: &Dir, relative: &Path, absolute: &Path) -> io::Result<Option<fs::File>> {
    if !cargo_pool_slot(absolute) {
        return Ok(None);
    }
    let lock_path = relative.with_extension("lock");
    if root
        .symlink_metadata(&lock_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Cargo slot lock is a symlink",
        ));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let lock = root.open_with(lock_path, &options)?.into_std();
    lock.try_lock()?;
    Ok(Some(lock))
}

fn allowed_roots() -> io::Result<Vec<PathBuf>> {
    let value = std::env::var("GCTRL_DISK_ALLOWLIST").unwrap_or_default();
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<PathBuf> = serde_json::from_str(&value).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("GCTRL_DISK_ALLOWLIST must be a JSON array: {e}"),
        )
    })?;
    paths
        .into_iter()
        .map(|path| {
            if !path.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "allowlisted paths must be absolute",
                ));
            }
            path.canonicalize()
        })
        .collect()
}

fn inside(root: &Path, path: &Path) -> bool {
    path != root && path.starts_with(root)
}

/// Docker's daemon data root must resolve on this host inside an allowed path.
pub fn docker_root_is_allowed(roots: &[PathBuf], docker_root: &Path) -> bool {
    let Ok(docker_root) = docker_root.canonicalize() else {
        return false;
    };
    roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| docker_root == root || docker_root.starts_with(&root))
}

fn docker_output(args: &[&str]) -> io::Result<String> {
    let output = Command::new("docker").args(args).output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn checked_docker_root(roots: &[PathBuf]) -> io::Result<String> {
    if cfg!(not(target_os = "linux")) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Docker cache pruning requires a host-local Linux daemon",
        ));
    }
    if roots.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "disk allowlist is empty",
        ));
    }
    if std::env::var("DOCKER_HOST").is_ok_and(|host| !host.starts_with("unix://")) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "remote Docker hosts are outside the disk allowlist",
        ));
    }
    let endpoint = docker_output(&[
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
    ])?;
    if !endpoint.trim().starts_with("unix://") {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Docker context is not a local Unix socket",
        ));
    }
    let path = docker_output(&["info", "--format", "{{.DockerRootDir}}"])?;
    let attested = std::env::var("GCTRL_DOCKER_LOCAL_ROOT").unwrap_or_default();
    if attested.is_empty()
        || Path::new(&attested).canonicalize().ok() != Path::new(path.trim()).canonicalize().ok()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "set GCTRL_DOCKER_LOCAL_ROOT to the host-mapped Docker data root",
        ));
    }
    if !docker_root_is_allowed(roots, Path::new(path.trim())) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Docker data root is not a verifiable host path inside the disk allowlist",
        ));
    }
    let inspect = docker_output(&["buildx", "inspect"])?;
    let local_driver = inspect.lines().any(|line| {
        line.trim_start()
            .strip_prefix("Driver:")
            .is_some_and(|driver| driver.trim() == "docker")
    });
    if !local_driver {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "active Docker builder does not use the local docker driver",
        ));
    }
    let name = inspect
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("Name:").map(str::trim))
        .filter(|name| !name.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Docker builder has no name"))?;
    Ok(name.to_string())
}

fn docker_candidates(roots: &[PathBuf]) -> io::Result<(String, Vec<DockerCandidate>)> {
    let builder = checked_docker_root(roots)?;
    let output = docker_output(&["buildx", "du", "--builder", &builder, "--format=json"])?;
    let candidates = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            let id = value["ID"].as_str().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Docker cache record has no ID")
            })?;
            let bytes = value["Size"]
                .as_str()
                .and_then(|raw| raw.parse::<u64>().ok())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Docker cache record has no byte size",
                    )
                })?;
            Ok(DockerCandidate {
                id: id.to_string(),
                bytes,
                description: value["Description"]
                    .as_str()
                    .unwrap_or("Docker build cache")
                    .to_string(),
                reclaimable: value["Reclaimable"].as_bool().unwrap_or(false),
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    Ok((builder, candidates))
}

fn size_and_candidates(
    dir: &Dir,
    relative: &Path,
    root: &Path,
    candidates: &mut Vec<DiskCandidate>,
) -> io::Result<u64> {
    let metadata = dir.symlink_metadata(relative)?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut bytes = 0_u64;
    for entry in dir.read_dir(relative)? {
        let entry = entry?;
        let child = relative.join(entry.file_name());
        match size_and_candidates(dir, &child, root, candidates) {
            Ok(child_bytes) => bytes = bytes.saturating_add(child_bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let path = root.join(relative);
    if inside(root, &path) {
        if let Some(kind) = candidate_kind(&path) {
            if cargo_pool_slot(&path) && lock_cargo_slot(dir, relative, &path).is_err() {
                return Ok(bytes);
            }
            candidates.retain(|candidate| !candidate.path.starts_with(&path));
            candidates.push(DiskCandidate { path, bytes, kind });
        }
    }
    Ok(bytes)
}

/// Scan only the configured roots. Symlink targets are never traversed.
pub fn scan_roots(roots: &[PathBuf]) -> io::Result<DiskReport> {
    let mut report = DiskReport {
        roots: Vec::new(),
        candidates: Vec::new(),
    };
    let mut canonical_roots: Vec<PathBuf> = roots
        .iter()
        .map(|root| root.canonicalize())
        .collect::<io::Result<_>>()?;
    canonical_roots.sort();
    canonical_roots.dedup();
    for root in canonical_roots {
        if report
            .roots
            .iter()
            .any(|entry| root.starts_with(&entry.path))
        {
            continue;
        }
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "allowlisted root is not a directory",
            ));
        }
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        let bytes = size_and_candidates(&dir, Path::new("."), &root, &mut report.candidates)?;
        report.roots.push(DiskRoot { path: root, bytes });
    }
    report.candidates.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Ok(report)
}

/// Remove a recognized build directory strictly below an allowlisted root.
pub fn remove_candidate(roots: &[PathBuf], path: &Path) -> io::Result<()> {
    if !path.is_absolute() || candidate_kind(path).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "path is not a recognized build output",
        ));
    }
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "candidate must not be a symlink",
        ));
    }
    let path = path.canonicalize()?;
    if candidate_kind(&path).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "resolved path is not a recognized build output",
        ));
    }
    for root in roots {
        let root = root.canonicalize()?;
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            continue;
        }
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        let metadata = dir.symlink_metadata(relative)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "candidate must be a directory, not a symlink",
            ));
        }
        let _slot_lock = lock_cargo_slot(&dir, relative, &path)?;
        return dir.remove_dir_all(relative);
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "candidate is outside the disk allowlist",
    ))
}

pub async fn scan(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<DiskReport>, (StatusCode, String)> {
    tokio::task::spawn_blocking(|| {
        let roots = allowed_roots().map_err(api_error)?;
        scan_roots(&roots).map(Json).map_err(api_error)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

pub async fn remove(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<RemoveRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || {
        let roots = allowed_roots().map_err(api_error)?;
        remove_candidate(&roots, &request.path).map_err(api_error)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

pub async fn docker_usage(State(_state): State<Arc<AppState>>) -> Json<DockerReport> {
    let result = tokio::task::spawn_blocking(|| {
        let roots = allowed_roots()?;
        docker_candidates(&roots)
    })
    .await;
    match result {
        Ok(Ok((_, candidates))) => Json(DockerReport {
            available: true,
            reason: None,
            candidates,
        }),
        Ok(Err(error)) => Json(DockerReport {
            available: false,
            reason: Some(error.to_string()),
            candidates: Vec::new(),
        }),
        Err(error) => Json(DockerReport {
            available: false,
            reason: Some(error.to_string()),
            candidates: Vec::new(),
        }),
    }
}

pub async fn docker_prune(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<PruneRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || {
        if request.id.is_empty()
            || !request
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "invalid Docker cache ID".to_string(),
            ));
        }
        let roots = allowed_roots().map_err(api_error)?;
        let (builder, candidates) = docker_candidates(&roots).map_err(api_error)?;
        if !candidates
            .iter()
            .any(|candidate| candidate.id == request.id && candidate.reclaimable)
        {
            return Err((
                StatusCode::FORBIDDEN,
                "cache record is not reclaimable".to_string(),
            ));
        }
        let filter = format!("id={}", request.id);
        docker_output(&[
            "buildx",
            "prune",
            "--builder",
            &builder,
            "--filter",
            &filter,
            "--force",
        ])
        .map_err(api_error)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
}

fn api_error(error: io::Error) -> (StatusCode, String) {
    let status = match error.kind() {
        io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        io::ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
        io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn scan_stays_with_open_root_after_path_is_replaced() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = parent.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("inside"), vec![0_u8; 11]).unwrap();
        fs::write(outside.path().join("outside"), vec![0_u8; 99]).unwrap();

        let dir = Dir::open_ambient_dir(&root, ambient_authority()).unwrap();
        fs::rename(&root, parent.path().join("moved")).unwrap();
        symlink(outside.path(), &root).unwrap();

        let bytes = size_and_candidates(&dir, Path::new("."), &root, &mut Vec::new()).unwrap();
        assert_eq!(bytes, 11);
        assert!(outside.path().join("outside").exists());
    }
}
