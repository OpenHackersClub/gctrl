//! SyncEngine — orchestrates Parquet export, R2 upload/download, and manifest tracking.

use async_trait::async_trait;
use chrono::Utc;
use duckdb::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use gctl_core::{
    SyncConfig, SyncManifest, SyncManifestEntry, SyncPendingRows, SyncResult, SyncStatus,
    SyncTableResult,
};

use crate::manifest;
use crate::parquet_export::{self, SYNCABLE_TABLES};
use crate::r2::R2Client;
use crate::SyncError;

/// Port: sync engine operations.
#[async_trait]
pub trait SyncEngine: Send + Sync {
    /// Export unsynced rows to Parquet, upload to R2, mark synced.
    async fn push(&self, tables: &[&str]) -> Result<SyncResult, SyncError>;

    /// Download new Parquet files from R2, insert into local DuckDB.
    async fn pull(&self, tables: &[&str]) -> Result<SyncResult, SyncError>;

    /// Show sync state: pending rows, last push/pull, R2 connectivity.
    async fn status(&self) -> Result<SyncStatus, SyncError>;
}

/// R2-backed sync engine.
pub struct R2SyncEngine {
    conn: Mutex<Connection>,
    r2: R2Client,
    config: SyncConfig,
    sync_dir: PathBuf,
    workspace_id: String,
}

impl R2SyncEngine {
    /// Create a new sync engine.
    ///
    /// `conn` — DuckDB connection (shared with the daemon; caller manages locking).
    /// `config` — sync configuration (bucket, endpoint, credentials, device_id).
    /// `sync_dir` — local staging directory for Parquet files.
    /// `workspace_id` — workspace identifier for R2 path partitioning.
    pub fn new(
        conn: Connection,
        config: SyncConfig,
        sync_dir: PathBuf,
        workspace_id: String,
    ) -> Self {
        let r2 = R2Client::new(
            &config.r2_endpoint,
            &config.r2_bucket,
            &config.r2_access_key_id,
            &config.r2_secret_access_key,
        );
        Self {
            conn: Mutex::new(conn),
            r2,
            config,
            sync_dir,
            workspace_id,
        }
    }

    /// Resolve which tables to sync: if `tables` is empty, use all syncable tables.
    fn resolve_tables<'a>(&self, tables: &'a [&'a str]) -> Vec<&'a str> {
        if tables.is_empty() {
            SYNCABLE_TABLES.to_vec()
        } else {
            tables.to_vec()
        }
    }

    /// Build the R2 key for a Parquet file.
    fn r2_key(&self, device_id: &str, table: &str, date: &str, push_id: &str) -> String {
        format!("{ws}/{dev}/{table}/{date}/{push_id}.parquet",
            ws = self.workspace_id,
            dev = device_id,
        )
    }
}

#[async_trait]
impl SyncEngine for R2SyncEngine {
    async fn push(&self, tables: &[&str]) -> Result<SyncResult, SyncError> {
        let tables = self.resolve_tables(tables);
        let push_id = Uuid::new_v4().to_string();
        let date = Utc::now().format("%Y-%m-%d").to_string();
        let device_id = &self.config.device_id;

        let mut result = SyncResult::default();
        let mut table_results = Vec::new();

        for &table in &tables {
            let local_path = parquet_export::staging_path(
                &self.sync_dir,
                device_id,
                table,
                &date,
                &push_id,
            );

            // Export unsynced rows to Parquet.
            let count = {
                let conn = self.conn.lock().unwrap();
                parquet_export::export_table(&conn, table, &local_path)?
            };

            if count == 0 {
                continue;
            }

            // Upload to R2.
            let r2_key = self.r2_key(device_id, table, &date, &push_id);
            self.r2.upload_file(&r2_key, &local_path).await?;

            // Mark rows as synced.
            {
                let conn = self.conn.lock().unwrap();
                parquet_export::mark_synced(&conn, table)?;
            }

            info!(table, count, r2_key, "pushed to R2");
            result.total_rows += count;
            result.files.push(r2_key.clone());
            table_results.push(SyncTableResult {
                table: table.to_string(),
                row_count: count,
                parquet_path: r2_key,
            });
        }

        // Update manifest.
        if !table_results.is_empty() {
            let mut manifest = manifest::load_local(
                &self.sync_dir,
                &self.workspace_id,
                device_id,
            )
            .await?;

            let entry = SyncManifestEntry {
                push_id,
                device_id: device_id.clone(),
                timestamp: Utc::now(),
                tables: table_results.clone(),
            };
            manifest::record_push(&mut manifest, entry);
            manifest::save_local(&self.sync_dir, &manifest).await?;
        }

        result.tables = table_results;
        Ok(result)
    }

    async fn pull(&self, tables: &[&str]) -> Result<SyncResult, SyncError> {
        let tables = self.resolve_tables(tables);
        let device_id = &self.config.device_id;

        // Load remote manifest.
        let manifest_key = format!("{}/manifest.json", self.workspace_id);
        let manifest_bytes = match self.r2.get_object(&manifest_key).await {
            Ok(bytes) => bytes,
            Err(_) => {
                warn!("no remote manifest found, nothing to pull");
                return Ok(SyncResult::default());
            }
        };

        let remote_manifest: SyncManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| SyncError::Manifest(format!("parse remote manifest: {e}")))?;

        // Load local manifest to find watermark.
        let local_manifest = manifest::load_local(
            &self.sync_dir,
            &self.workspace_id,
            device_id,
        )
        .await?;

        let last_pull_ts = local_manifest
            .last_pull
            .as_ref()
            .map(|e| e.timestamp);

        let mut result = SyncResult::default();

        // Download and import Parquet files from other devices.
        for push_entry in &remote_manifest.pushes {
            // Skip our own pushes.
            if push_entry.device_id == *device_id {
                continue;
            }
            // Skip pushes before our last pull watermark.
            if let Some(ts) = last_pull_ts {
                if push_entry.timestamp <= ts {
                    continue;
                }
            }

            for table_result in &push_entry.tables {
                if !tables.contains(&table_result.table.as_str()) {
                    continue;
                }

                let local_path = self
                    .sync_dir
                    .join("pull")
                    .join(&table_result.parquet_path);

                // Download Parquet file.
                self.r2
                    .download_file(&table_result.parquet_path, &local_path)
                    .await?;

                // Import into DuckDB with INSERT OR IGNORE.
                let path_str = local_path.to_string_lossy().to_string();
                let table_name = &table_result.table;
                let sql = format!(
                    "INSERT OR IGNORE INTO {table_name} SELECT * FROM read_parquet('{path_str}')"
                );
                {
                    let conn = self.conn.lock().unwrap();
                    conn.execute_batch(&sql)
                        .map_err(|e| SyncError::Import(format!("import {table_name}: {e}")))?;
                }

                info!(table = %table_name, rows = table_result.row_count, "pulled from R2");
                result.total_rows += table_result.row_count;
                result.files.push(table_result.parquet_path.clone());
                result.tables.push(table_result.clone());
            }
        }

        // Update local manifest watermark.
        if !result.tables.is_empty() {
            let mut local_manifest = manifest::load_local(
                &self.sync_dir,
                &self.workspace_id,
                device_id,
            )
            .await?;

            local_manifest.last_pull = Some(gctl_core::SyncEvent {
                timestamp: Utc::now(),
                push_id: "pull".into(),
                total_rows: result.total_rows,
            });
            manifest::save_local(&self.sync_dir, &local_manifest).await?;
        }

        Ok(result)
    }

    async fn status(&self) -> Result<SyncStatus, SyncError> {
        let device_id = &self.config.device_id;

        // Count pending rows per table.
        let pending = {
            let conn = self.conn.lock().unwrap();
            SyncPendingRows {
                sessions: parquet_export::pending_count(&conn, "sessions").unwrap_or(0),
                spans: parquet_export::pending_count(&conn, "spans").unwrap_or(0),
                traffic: parquet_export::pending_count(&conn, "traffic").unwrap_or(0),
                tasks: parquet_export::pending_count(&conn, "tasks").unwrap_or(0),
                context: 0, // TODO: context pending count from context_entries table
            }
        };

        // Load manifest for last push/pull info.
        let manifest = manifest::load_local(
            &self.sync_dir,
            &self.workspace_id,
            device_id,
        )
        .await?;

        let last_push = manifest.pushes.last().map(|entry| gctl_core::SyncEvent {
            timestamp: entry.timestamp,
            push_id: entry.push_id.clone(),
            total_rows: entry.tables.iter().map(|t| t.row_count).sum(),
        });

        // Check R2 connectivity.
        let r2_reachable = if self.config.enabled {
            Some(self.r2.health_check().await)
        } else {
            None
        };

        Ok(SyncStatus {
            enabled: self.config.enabled,
            device_id: device_id.clone(),
            pending_rows: pending,
            last_push,
            last_pull: manifest.last_pull,
            r2_reachable,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> SyncConfig {
        SyncConfig {
            enabled: false,
            r2_bucket: "test-bucket".into(),
            r2_endpoint: "https://test.r2.cloudflarestorage.com".into(),
            r2_access_key_id: "test-key".into(),
            r2_secret_access_key: "test-secret".into(),
            interval_seconds: 300,
            device_id: "test-dev".into(),
            auto_pull: false,
        }
    }

    #[test]
    fn resolve_tables_empty_returns_all() {
        let conn = Connection::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        );
        let tables = engine.resolve_tables(&[]);
        assert_eq!(tables, SYNCABLE_TABLES);
    }

    #[test]
    fn resolve_tables_specific() {
        let conn = Connection::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        );
        let tables = engine.resolve_tables(&["sessions"]);
        assert_eq!(tables, vec!["sessions"]);
    }

    #[test]
    fn r2_key_format() {
        let conn = Connection::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        );
        let key = engine.r2_key("dev1", "sessions", "2026-04-06", "push-abc");
        assert_eq!(key, "ws1/dev1/sessions/2026-04-06/push-abc.parquet");
    }

    #[tokio::test]
    async fn status_with_empty_db() {
        let conn = Connection::open_in_memory().unwrap();
        // Create tables so pending_count queries work.
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE tasks (id VARCHAR, synced BOOLEAN DEFAULT FALSE);",
        )
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        );
        let status = engine.status().await.unwrap();
        assert!(!status.enabled);
        assert_eq!(status.device_id, "test-dev");
        assert_eq!(status.pending_rows.sessions, 0);
        assert_eq!(status.pending_rows.spans, 0);
        assert!(status.last_push.is_none());
        assert!(status.last_pull.is_none());
    }

    #[tokio::test]
    async fn status_counts_pending_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE tasks (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             INSERT INTO sessions VALUES ('s1', FALSE);
             INSERT INTO sessions VALUES ('s2', TRUE);
             INSERT INTO spans VALUES ('sp1', FALSE);
             INSERT INTO spans VALUES ('sp2', FALSE);
             INSERT INTO spans VALUES ('sp3', FALSE);",
        )
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        );
        let status = engine.status().await.unwrap();
        assert_eq!(status.pending_rows.sessions, 1);
        assert_eq!(status.pending_rows.spans, 3);
        assert_eq!(status.pending_rows.traffic, 0);
        assert_eq!(status.pending_rows.tasks, 0);
    }
}
