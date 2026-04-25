//! Atomic vault file I/O.
//!
//! Vault files (issue records, briefs, persona definitions) are the source of
//! truth in gctrl's vault model — SQLite holds an index keyed by `vault_path`
//! and `content_hash`. Writes from kernel-side handlers must use this module
//! to avoid torn files (Obsidian + watcher both read partial writes otherwise)
//! and to keep the recorded `content_hash` in lockstep with the bytes on disk.
//!
//! Pattern (from Uebermensch): write to `<path>.tmp` → fsync → rename → SHA-256.
//! The rename is atomic on POSIX filesystems; either the new bytes or the old
//! bytes are visible to a concurrent reader, never a torn mix.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use sha2::{Digest, Sha256};

use gctrl_core::{GctlError, Result};

/// Atomically write `body` to `path` and return the SHA-256 hash of the bytes
/// that landed on disk. Creates parent directories as needed.
///
/// The caller should write the returned hash into the corresponding SQL index
/// row (`vault_path`, `content_hash`) so the watcher's next event is a no-op.
pub fn write_atomic(path: &Path, body: &str) -> Result<String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| GctlError::Storage(format!("create_dir_all {}: {e}", parent.display())))?;
        }
    }

    let tmp_path = with_tmp_suffix(path);

    let mut file = File::create(&tmp_path)
        .map_err(|e| GctlError::Storage(format!("create {}: {e}", tmp_path.display())))?;
    file.write_all(body.as_bytes())
        .map_err(|e| GctlError::Storage(format!("write {}: {e}", tmp_path.display())))?;
    file.sync_all()
        .map_err(|e| GctlError::Storage(format!("fsync {}: {e}", tmp_path.display())))?;
    drop(file);

    fs::rename(&tmp_path, path)
        .map_err(|e| GctlError::Storage(format!("rename {} → {}: {e}", tmp_path.display(), path.display())))?;

    Ok(sha256_hex(body))
}

/// SHA-256 hex digest of the given content.
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn with_tmp_suffix(path: &Path) -> std::path::PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(".tmp");
    std::path::PathBuf::from(os)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn write_atomic_creates_file_and_returns_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("BOARD-1.md");
        let body = "---\nid: BOARD-1\n---\n\n# Hello\n";

        let hash = write_atomic(&path, body).unwrap();

        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert_eq!(hash, sha256_hex(body));
        assert_eq!(hash.len(), 64); // SHA-256 hex digest
    }

    #[test]
    fn write_atomic_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deep/file.md");

        write_atomic(&path, "x").unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_atomic_overwrites_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.md");
        write_atomic(&path, "first").unwrap();
        let hash2 = write_atomic(&path, "second").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(hash2, sha256_hex("second"));
    }

    #[test]
    fn write_atomic_leaves_no_tmp_file_on_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.md");
        write_atomic(&path, "body").unwrap();

        let tmp = dir.path().join("file.md.tmp");
        assert!(!tmp.exists(), "tmp file must be renamed away on success");
    }

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
