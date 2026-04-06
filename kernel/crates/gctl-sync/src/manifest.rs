//! Sync manifest — tracks push/pull state on disk and in R2.

use gctl_core::{SyncEvent, SyncManifest, SyncManifestEntry};
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::SyncError;

/// Default manifest filename.
const MANIFEST_FILE: &str = "manifest.json";

/// Load a manifest from a local directory, or return a default.
pub async fn load_local(
    sync_dir: &Path,
    workspace_id: &str,
    device_id: &str,
) -> Result<SyncManifest, SyncError> {
    let path = sync_dir.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(SyncManifest {
            workspace_id: workspace_id.to_string(),
            device_id: device_id.to_string(),
            ..Default::default()
        });
    }
    let data = fs::read_to_string(&path)
        .await
        .map_err(|e| SyncError::Io(format!("read manifest: {e}")))?;
    serde_json::from_str(&data).map_err(|e| SyncError::Manifest(format!("parse manifest: {e}")))
}

/// Save a manifest to the local sync directory.
pub async fn save_local(sync_dir: &Path, manifest: &SyncManifest) -> Result<(), SyncError> {
    fs::create_dir_all(sync_dir)
        .await
        .map_err(|e| SyncError::Io(format!("create sync dir: {e}")))?;
    let path = sync_dir.join(MANIFEST_FILE);
    let data = serde_json::to_string_pretty(manifest)
        .map_err(|e| SyncError::Manifest(format!("serialize manifest: {e}")))?;
    fs::write(&path, data)
        .await
        .map_err(|e| SyncError::Io(format!("write manifest: {e}")))?;
    Ok(())
}

/// Append a push entry to the manifest.
pub fn record_push(manifest: &mut SyncManifest, entry: SyncManifestEntry) {
    let event = SyncEvent {
        timestamp: entry.timestamp,
        push_id: entry.push_id.clone(),
        total_rows: entry.tables.iter().map(|t| t.row_count).sum(),
    };
    manifest.pushes.push(entry);
    manifest.last_pull = manifest.last_pull.take(); // preserve
    // Update implicit "last push" by looking at pushes
    let _ = event; // event is embedded in pushes vec
}

/// Get the path where a manifest would live in the local sync directory.
pub fn manifest_path(sync_dir: &Path) -> PathBuf {
    sync_dir.join(MANIFEST_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctl_core::SyncTableResult;

    #[tokio::test]
    async fn load_missing_manifest_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let m = load_local(dir.path(), "ws1", "dev1").await.unwrap();
        assert_eq!(m.workspace_id, "ws1");
        assert_eq!(m.device_id, "dev1");
        assert!(m.pushes.is_empty());
    }

    #[tokio::test]
    async fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = SyncManifest {
            workspace_id: "ws1".into(),
            device_id: "dev1".into(),
            pushes: vec![SyncManifestEntry {
                push_id: "p1".into(),
                device_id: "dev1".into(),
                timestamp: Utc::now(),
                tables: vec![SyncTableResult {
                    table: "sessions".into(),
                    row_count: 3,
                    parquet_path: "dev1/sessions/2026-04-06/p1.parquet".into(),
                }],
            }],
            last_pull: None,
            context_hashes: vec!["abc".into()],
        };
        save_local(dir.path(), &manifest).await.unwrap();
        let loaded = load_local(dir.path(), "ws1", "dev1").await.unwrap();
        assert_eq!(loaded.pushes.len(), 1);
        assert_eq!(loaded.pushes[0].push_id, "p1");
        assert_eq!(loaded.context_hashes, vec!["abc"]);
    }

    #[test]
    fn record_push_appends_entry() {
        let mut m = SyncManifest::default();
        let entry = SyncManifestEntry {
            push_id: "p1".into(),
            device_id: "dev1".into(),
            timestamp: Utc::now(),
            tables: vec![SyncTableResult {
                table: "spans".into(),
                row_count: 10,
                parquet_path: "path.parquet".into(),
            }],
        };
        record_push(&mut m, entry);
        assert_eq!(m.pushes.len(), 1);
        assert_eq!(m.pushes[0].tables[0].row_count, 10);
    }
}
