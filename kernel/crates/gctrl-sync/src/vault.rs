//! Vault file sync — push/pull a project-key subtree of the kernel-owned
//! vault root to/from R2.
//!
//! Spec: `vault/specs/architecture/kernel/sync.md` § 2.4 +
//!        `vault/specs/implementation/kernel/sync-vault.md`.
//!
//! The sync model is:
//!   - Kernel owns the vault root (resolved at daemon startup from
//!     `--board-dir` → `GCTRL_BOARD_DIR` → `./gctrl/`, per #163).
//!   - Each top-level subdirectory under the root is a "project key" owned
//!     by exactly one installed app (registered via `gctrl_vault_mounts`).
//!   - For a project key `K`, sync walks `<vault_root>/<K>/...` and mirrors
//!     it to R2 at `vaults/<K>/...`. Files are deduped by SHA-256 against a
//!     per-project manifest at `~/.local/share/gctrl/sync/vaults/<K>.json`.
//!
//! This module is the **planner + manifest + walker**. The R2 transport
//! integration lands alongside (`R2SyncEngine::push_vault` is a thin loop
//! over the planner's output that calls `R2Client::put_object`). HTTP
//! routes (`/api/sync/vault/{push,pull,status}`) land in PR-β.2.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::SyncError;

// ───────────────────────── Public types ─────────────────────────

/// One row in the push/pull plan — an authoritative description of what the
/// sync would do for a single file. The planner produces this; `push_vault`
/// loops over it and executes via `R2Client`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultSyncPlanEntry {
    /// Project-key-relative path (e.g. `input/briefs/2026-05-03.md`).
    /// Forward-slash-separated even on Windows so it round-trips through R2
    /// keys without OS-dependent transforms.
    pub rel_path: String,
    /// Lowercase hex SHA-256 of the file contents.
    pub sha256: String,
    pub size_bytes: u64,
    pub action: VaultSyncAction,
}

/// What the planner thinks should happen to a given file. `Skip` carries a
/// reason so operators can tell at a glance why a file was untouched.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VaultSyncAction {
    /// File is new on disk OR its sha changed since last push — needs upload.
    Upload,
    /// Sha matches the manifest entry — skip.
    SkipHashMatch,
    /// Caller passed `prefixes` and this file isn't under any of them.
    SkipOutsidePrefix,
}

/// Aggregate result of `push_vault` (or a dry-run planning call). Plan is
/// always populated; counts reflect what the executor actually did. For
/// `dry_run=true` callers, `uploaded` / `bytes_uploaded` stay zero and
/// `plan` is the answer.
#[derive(Debug, Clone, Serialize)]
pub struct VaultSyncResult {
    pub project_key: String,
    pub plan: Vec<VaultSyncPlanEntry>,
    pub uploaded: u64,
    pub skipped: u64,
    pub failed: u64,
    pub bytes_uploaded: u64,
}

/// Operator-facing knobs.
#[derive(Debug, Clone, Default)]
pub struct VaultSyncOpts {
    /// Plan only — do not call into R2.
    pub dry_run: bool,
    /// Re-upload even if the manifest hash matches. Useful after a manual
    /// R2 cleanup or to force re-prime a fresh bucket.
    pub force: bool,
    /// Bound on parallel R2 uploads. Default 8.
    pub concurrency: usize,
}

// ───────────────────────── Manifest ─────────────────────────

/// Per-project sync manifest. Stored as one JSON file per project key under
/// `<state_dir>/sync/vaults/<project-key>.json`. Atomic write via
/// `tmp+rename`. The manifest is **kernel-owned** (under
/// `~/.local/share/gctrl/`) — never inside the app vault — so an Obsidian
/// edit can't accidentally corrupt it and uninstalling an app doesn't lose
/// sync state for a future re-install.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultManifest {
    pub version: u32,
    pub project_key: String,
    /// RFC3339. `None` for an empty manifest (never pushed).
    pub updated_at: Option<String>,
    /// Map: project-key-relative path → entry. `BTreeMap` for stable key
    /// ordering when round-tripping through JSON.
    pub entries: BTreeMap<String, VaultManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultManifestEntry {
    pub sha256: String,
    pub size_bytes: u64,
    /// RFC3339 UTC of the last successful upload of this file.
    pub uploaded_at: String,
    /// R2 ETag returned by the PUT response, when the transport surfaces it.
    /// Used for diagnostic comparison against `sha256` — the canonical dedup
    /// signal is still `sha256`.
    #[serde(default)]
    pub etag: Option<String>,
}

impl VaultManifest {
    pub fn empty(project_key: &str) -> Self {
        Self {
            version: 1,
            project_key: project_key.to_string(),
            updated_at: None,
            entries: BTreeMap::new(),
        }
    }

    /// Resolve the on-disk path for a project key's manifest under the
    /// kernel's state dir. Caller passes the state dir (typically
    /// `~/.local/share/gctrl`) so tests can use a `TempDir`.
    pub fn path(state_dir: &Path, project_key: &str) -> PathBuf {
        state_dir
            .join("sync")
            .join("vaults")
            .join(format!("{project_key}.json"))
    }

    /// Read a manifest from disk. Returns `Self::empty(project_key)` when
    /// the file does not exist (first push) — never an error.
    pub fn load(state_dir: &Path, project_key: &str) -> Result<Self, SyncError> {
        let path = Self::path(state_dir, project_key);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                SyncError::Manifest(format!("parse {}: {e}", path.display()))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(Self::empty(project_key))
            }
            Err(e) => Err(SyncError::Io(format!(
                "read {}: {e}",
                path.display()
            ))),
        }
    }

    /// Atomic write — serialize to a sibling `.tmp-<pid>` file, then
    /// `rename` over the canonical path. Sibling-tmp matters: a cross-FS
    /// `rename` would silently fail or copy.
    pub fn save(&self, state_dir: &Path) -> Result<(), SyncError> {
        let path = Self::path(state_dir, &self.project_key);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                SyncError::Io(format!("mkdir {}: {e}", parent.display()))
            })?;
        }
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| SyncError::Manifest(format!("serialize: {e}")))?;
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&tmp, &bytes).map_err(|e| {
            SyncError::Io(format!("write tmp {}: {e}", tmp.display()))
        })?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            SyncError::Io(format!(
                "rename {} -> {}: {e}",
                tmp.display(),
                path.display()
            ))
        })?;
        Ok(())
    }
}

// ───────────────────────── Planner ─────────────────────────

/// Walk `<vault_root>/<project_key>/` and produce a sync plan against the
/// supplied manifest. Pure: no R2, no I/O beyond the file walk + sha hash.
///
/// `prefixes`: project-key-relative subtree filters (e.g.
/// `["input/briefs", "input/raw"]`). Empty slice means the whole project
/// subtree.
///
/// Skips:
///   - Directories themselves (we only emit file rows).
///   - Dotfiles + dot-directories at any level (`.git`, `.obsidian`, …).
///   - Files outside the supplied `prefixes`, marked with
///     `SkipOutsidePrefix` so the count is auditable.
///
/// Errors:
///   - The project subtree being missing is **not** an error — returns an
///     empty plan. Apps that haven't written anything yet shouldn't fail.
///   - I/O errors during hashing surface as `SyncError::Io`.
pub fn plan_push(
    vault_root: &Path,
    project_key: &str,
    prefixes: &[&str],
    manifest: &VaultManifest,
    force: bool,
) -> Result<Vec<VaultSyncPlanEntry>, SyncError> {
    let project_root = vault_root.join(project_key);
    if !project_root.exists() {
        return Ok(Vec::new());
    }
    let mut plan = Vec::new();
    for entry in WalkDir::new(&project_root).sort_by_file_name() {
        let entry = entry.map_err(|e| {
            SyncError::Io(format!(
                "walk {}: {}",
                project_root.display(),
                e
            ))
        })?;
        if !entry.file_type().is_file() {
            continue;
        }

        let abs = entry.path();
        let rel = abs
            .strip_prefix(&project_root)
            .map_err(|_| {
                SyncError::Io(format!(
                    "path {} not under project root {}",
                    abs.display(),
                    project_root.display()
                ))
            })?;
        // Skip dotfiles + anything inside a dot-directory. Only the
        // project-key-relative components matter — the absolute path can
        // legitimately contain dot-prefixed segments (macOS TempDir,
        // `~/.local/share/`) that we MUST NOT filter on.
        if rel
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .any(|s| s.starts_with('.'))
        {
            continue;
        }
        let rel_str = rel
            .to_str()
            .ok_or_else(|| {
                SyncError::Io(format!("non-utf8 path: {}", rel.display()))
            })?
            .replace('\\', "/");

        let metadata = std::fs::metadata(abs).map_err(|e| {
            SyncError::Io(format!("stat {}: {e}", abs.display()))
        })?;
        let size_bytes = metadata.len();
        let sha256 = sha256_file(abs)?;

        let action = if !is_under_any_prefix(&rel_str, prefixes) {
            VaultSyncAction::SkipOutsidePrefix
        } else if !force
            && manifest
                .entries
                .get(&rel_str)
                .is_some_and(|m| m.sha256 == sha256)
        {
            VaultSyncAction::SkipHashMatch
        } else {
            VaultSyncAction::Upload
        };
        plan.push(VaultSyncPlanEntry {
            rel_path: rel_str,
            sha256,
            size_bytes,
            action,
        });
    }
    Ok(plan)
}

/// Build the R2 key for a project-key-relative path. Caller ensures
/// `rel_path` is forward-slash; this just slaps the `vaults/<project_key>/`
/// prefix on. Match the layout in `sync.md` § 3.1.
pub fn r2_key(project_key: &str, rel_path: &str) -> String {
    format!("vaults/{project_key}/{rel_path}")
}

fn is_under_any_prefix(rel_path: &str, prefixes: &[&str]) -> bool {
    if prefixes.is_empty() {
        return true;
    }
    prefixes.iter().any(|p| {
        let p = p.trim_end_matches('/');
        rel_path == p || rel_path.starts_with(&format!("{p}/"))
    })
}

fn sha256_file(path: &Path) -> Result<String, SyncError> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| SyncError::Io(format!("open {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| {
            SyncError::Io(format!("read {}: {e}", path.display()))
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ───────────────────────── Tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &[u8]) {
        let abs = dir.join(rel);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(abs, content).unwrap();
    }

    #[test]
    fn plan_walks_project_subtree_only() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/input/briefs/a.md", b"a");
        write(root.path(), "UBER/input/briefs/b.md", b"b");
        write(root.path(), "BOARD/BOARD-1.md", b"# Board");
        let plan = plan_push(
            root.path(),
            "UBER",
            &[],
            &VaultManifest::empty("UBER"),
            false,
        )
        .unwrap();
        let paths: Vec<&str> = plan.iter().map(|p| p.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["input/briefs/a.md", "input/briefs/b.md"]);
    }

    #[test]
    fn missing_project_returns_empty_plan() {
        let root = TempDir::new().unwrap();
        let plan = plan_push(
            root.path(),
            "NEVER_WRITTEN",
            &[],
            &VaultManifest::empty("NEVER_WRITTEN"),
            false,
        )
        .unwrap();
        assert!(plan.is_empty());
    }

    #[test]
    fn skips_dotfiles_and_dot_directories() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/.uber-state.json", b"local-only");
        write(root.path(), "UBER/.git/HEAD", b"ref: refs/heads/main");
        write(root.path(), "UBER/.obsidian/workspace.json", b"{}");
        write(root.path(), "UBER/input/briefs/a.md", b"a");
        let plan = plan_push(
            root.path(),
            "UBER",
            &[],
            &VaultManifest::empty("UBER"),
            false,
        )
        .unwrap();
        let paths: Vec<&str> = plan.iter().map(|p| p.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["input/briefs/a.md"]);
    }

    #[test]
    fn prefix_filter_marks_outside_files_as_skip() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/input/briefs/a.md", b"a");
        write(root.path(), "UBER/output/reports/x.md", b"x");
        let plan = plan_push(
            root.path(),
            "UBER",
            &["input/briefs"],
            &VaultManifest::empty("UBER"),
            false,
        )
        .unwrap();
        // Both files appear in the plan; one is Upload, the other is
        // SkipOutsidePrefix (so an operator can audit what was filtered).
        assert_eq!(plan.len(), 2);
        let upload = plan.iter().find(|p| p.rel_path == "input/briefs/a.md").unwrap();
        assert_eq!(upload.action, VaultSyncAction::Upload);
        let skipped = plan.iter().find(|p| p.rel_path == "output/reports/x.md").unwrap();
        assert_eq!(skipped.action, VaultSyncAction::SkipOutsidePrefix);
    }

    #[test]
    fn manifest_hash_match_short_circuits_upload() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/input/briefs/a.md", b"a");
        let mut manifest = VaultManifest::empty("UBER");
        let sha = sha256_file(&root.path().join("UBER/input/briefs/a.md")).unwrap();
        manifest.entries.insert(
            "input/briefs/a.md".to_string(),
            VaultManifestEntry {
                sha256: sha.clone(),
                size_bytes: 1,
                uploaded_at: "2026-05-03T00:00:00Z".into(),
                etag: None,
            },
        );
        let plan = plan_push(root.path(), "UBER", &[], &manifest, false).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].action, VaultSyncAction::SkipHashMatch);
        assert_eq!(plan[0].sha256, sha);
    }

    #[test]
    fn force_re_uploads_even_when_hash_matches() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/x.md", b"x");
        let mut manifest = VaultManifest::empty("UBER");
        let sha = sha256_file(&root.path().join("UBER/x.md")).unwrap();
        manifest.entries.insert(
            "x.md".into(),
            VaultManifestEntry {
                sha256: sha,
                size_bytes: 1,
                uploaded_at: "2026-05-03T00:00:00Z".into(),
                etag: None,
            },
        );
        let plan = plan_push(root.path(), "UBER", &[], &manifest, /*force=*/ true).unwrap();
        assert_eq!(plan[0].action, VaultSyncAction::Upload);
    }

    #[test]
    fn changed_content_marked_for_upload() {
        let root = TempDir::new().unwrap();
        write(root.path(), "UBER/x.md", b"new content");
        let mut manifest = VaultManifest::empty("UBER");
        manifest.entries.insert(
            "x.md".into(),
            VaultManifestEntry {
                sha256: "old".into(),
                size_bytes: 0,
                uploaded_at: "2026-05-03T00:00:00Z".into(),
                etag: None,
            },
        );
        let plan = plan_push(root.path(), "UBER", &[], &manifest, false).unwrap();
        assert_eq!(plan[0].action, VaultSyncAction::Upload);
        assert_ne!(plan[0].sha256, "old");
    }

    #[test]
    fn plan_is_sorted_for_determinism() {
        let root = TempDir::new().unwrap();
        for name in ["c.md", "a.md", "b.md"] {
            write(root.path(), &format!("UBER/{name}"), name.as_bytes());
        }
        let plan = plan_push(
            root.path(),
            "UBER",
            &[],
            &VaultManifest::empty("UBER"),
            false,
        )
        .unwrap();
        let names: Vec<&str> = plan.iter().map(|p| p.rel_path.as_str()).collect();
        assert_eq!(names, vec!["a.md", "b.md", "c.md"]);
    }

    #[test]
    fn r2_key_uses_project_prefix() {
        assert_eq!(
            r2_key("UBER", "input/briefs/2026-05-03.md"),
            "vaults/UBER/input/briefs/2026-05-03.md"
        );
        assert_eq!(r2_key("BOARD", "BOARD-1.md"), "vaults/BOARD/BOARD-1.md");
    }

    #[test]
    fn manifest_round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let mut m = VaultManifest::empty("UBER");
        m.updated_at = Some("2026-05-03T12:00:00Z".into());
        m.entries.insert(
            "input/briefs/a.md".into(),
            VaultManifestEntry {
                sha256: "abc".into(),
                size_bytes: 1,
                uploaded_at: "2026-05-03T12:00:00Z".into(),
                etag: Some("etag-1".into()),
            },
        );
        m.save(dir.path()).unwrap();
        let loaded = VaultManifest::load(dir.path(), "UBER").unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn manifest_load_missing_returns_empty() {
        let dir = TempDir::new().unwrap();
        let m = VaultManifest::load(dir.path(), "NEVER_PUSHED").unwrap();
        assert_eq!(m, VaultManifest::empty("NEVER_PUSHED"));
    }

    #[test]
    fn manifest_save_creates_parents() {
        let dir = TempDir::new().unwrap();
        // dir/sync/vaults/ doesn't exist yet — save must mkdir -p.
        let m = VaultManifest::empty("UBER");
        m.save(dir.path()).unwrap();
        assert!(VaultManifest::path(dir.path(), "UBER").exists());
    }
}
