//! SyncEngine — orchestrates dual-path sync:
//!   DuckDB → R2 (Parquet) for OLAP telemetry tables
//!   SQLite  → D1 (row-level) for OLTP board/task tables
//!
//! See `specs/architecture/kernel/sync.md` for the full design.

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

use crate::d1::{D1Client, D1_SYNCABLE_TABLES};
use crate::manifest;
use crate::parquet_export::{self, SYNCABLE_TABLES};
use crate::r2::R2Client;
use crate::SyncError;

/// Port: sync engine operations.
#[async_trait]
pub trait SyncEngine: Send + Sync {
    /// Push unsynced rows to the cloud.
    /// - DuckDB tables: Parquet → R2
    /// - SQLite tables: batch INSERT OR REPLACE → D1
    async fn push(&self, tables: &[&str]) -> Result<SyncResult, SyncError>;

    /// Pull new data from the cloud into local stores.
    /// - R2 → DuckDB: download Parquet → INSERT OR IGNORE
    /// - D1 → SQLite: query changed rows → INSERT OR REPLACE
    async fn pull(&self, tables: &[&str]) -> Result<SyncResult, SyncError>;

    /// Show sync state: pending rows per store, last push/pull, R2+D1 connectivity.
    async fn status(&self) -> Result<SyncStatus, SyncError>;
}

/// Dual-path sync engine: R2 for DuckDB (OLAP) + D1 for SQLite (OLTP).
pub struct R2SyncEngine {
    conn: Mutex<Connection>,
    r2: R2Client,
    d1: Option<D1Client>,
    config: SyncConfig,
    sync_dir: PathBuf,
    workspace_id: String,
}

impl R2SyncEngine {
    /// Create a new sync engine.
    ///
    /// `conn` — DuckDB connection (OLAP; caller manages locking).
    /// `config` — sync configuration. D1 client is created automatically if
    ///   `config.d1_enabled()` returns true.
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
        let d1 = if config.d1_enabled() {
            Some(D1Client::new(
                &config.d1_account_id,
                &config.d1_database_id,
                &config.d1_api_token,
            ))
        } else {
            None
        };
        Self {
            conn: Mutex::new(conn),
            r2,
            d1,
            config,
            sync_dir,
            workspace_id,
        }
    }

    /// Resolve which tables to sync: if `tables` is empty, use all syncable tables
    /// (both R2/DuckDB and D1/SQLite sets).
    fn resolve_tables<'a>(&self, tables: &'a [&'a str]) -> Vec<&'a str> {
        if tables.is_empty() {
            let mut all: Vec<&str> = SYNCABLE_TABLES.to_vec();
            all.extend_from_slice(D1_SYNCABLE_TABLES);
            all
        } else {
            tables.to_vec()
        }
    }

    /// Build the R2 key for a Parquet file.
    fn r2_key(&self, device_id: &str, table: &str, date: &str, push_id: &str) -> String {
        format!(
            "{ws}/{dev}/{table}/{date}/{push_id}.parquet",
            ws = self.workspace_id,
            dev = device_id,
        )
    }

    /// Push a single SQLite-backed table to D1.
    ///
    /// For now queries the DuckDB connection for any rows with `synced = FALSE`
    /// that belong to D1 tables (tasks). Board tables (projects, issues, etc.)
    /// are written directly by the Worker; local sync is a future iteration.
    async fn push_table_to_d1(
        &self,
        table: &str,
        _device_id: &str,
    ) -> Result<u64, SyncError> {
        let Some(d1) = &self.d1 else {
            warn!(table, "D1 push requested but D1 not configured — skipping");
            return Ok(0);
        };

        // For tables that live only in D1 (board_* tables managed by the Worker),
        // there are no local rows to push in this iteration — the Worker writes
        // directly to D1. For `tasks` we query DuckDB as an interim store.
        if table == "tasks" {
            let rows = {
                let conn = self.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT * FROM {table} WHERE synced = FALSE"
                    ))
                    .map_err(|e| SyncError::Export(format!("prepare {table}: {e}")))?;

                let col_names: Vec<String> = stmt
                    .column_names()
                    .into_iter()
                    .map(String::from)
                    .collect();

                let mut d1_rows = Vec::new();
                let mut query_rows = stmt
                    .query([])
                    .map_err(|e| SyncError::Export(format!("query {table}: {e}")))?;

                while let Some(row) = query_rows
                    .next()
                    .map_err(|e| SyncError::Export(format!("row {table}: {e}")))?
                {
                    let mut map = crate::d1::D1Row::new();
                    for (i, col) in col_names.iter().enumerate() {
                        if col == "synced" {
                            continue;
                        }
                        let val: Option<String> = row.get(i).unwrap_or(None);
                        map.insert(
                            col.clone(),
                            val.map(serde_json::Value::String)
                                .unwrap_or(serde_json::Value::Null),
                        );
                    }
                    d1_rows.push(map);
                }
                d1_rows
            };

            if rows.is_empty() {
                return Ok(0);
            }

            let count = d1.batch_upsert(table, &rows).await?;

            // Mark rows synced in DuckDB.
            {
                let conn = self.conn.lock().unwrap();
                conn.execute_batch(&format!(
                    "UPDATE {table} SET synced = TRUE WHERE synced = FALSE"
                ))
                .map_err(|e| SyncError::Export(format!("mark synced {table}: {e}")))?;
            }

            return Ok(count);
        }

        // Board tables (projects, issues, etc.) — no local rows to push yet.
        Ok(0)
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
            // Route: D1_SYNCABLE_TABLES → D1, everything else → R2/Parquet.
            if D1_SYNCABLE_TABLES.contains(&table) {
                let count = self.push_table_to_d1(table, device_id).await?;
                if count > 0 {
                    info!(table, count, "pushed to D1");
                    result.total_rows += count;
                    table_results.push(SyncTableResult {
                        table: table.to_string(),
                        row_count: count,
                        parquet_path: format!("d1://{table}"),
                    });
                }
                continue;
            }

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

        // Update local manifest for R2 pushes.
        let r2_results: Vec<_> = table_results
            .iter()
            .filter(|t| !t.parquet_path.starts_with("d1://"))
            .cloned()
            .collect();
        if !r2_results.is_empty() {
            let mut manifest = manifest::load_local(
                &self.sync_dir,
                &self.workspace_id,
                device_id,
            )
            .await?;
            manifest::record_push(
                &mut manifest,
                SyncManifestEntry {
                    push_id,
                    device_id: device_id.clone(),
                    timestamp: Utc::now(),
                    tables: r2_results,
                },
            );
            manifest::save_local(&self.sync_dir, &manifest).await?;
        }

        result.tables = table_results;
        Ok(result)
    }

    async fn pull(&self, tables: &[&str]) -> Result<SyncResult, SyncError> {
        let tables = self.resolve_tables(tables);
        let device_id = &self.config.device_id;
        let mut result = SyncResult::default();

        // ── D1 pull (SQLite tables) ──────────────────────────────────────────
        let d1_tables: Vec<&str> = tables
            .iter()
            .copied()
            .filter(|t| D1_SYNCABLE_TABLES.contains(t))
            .collect();
        if !d1_tables.is_empty() {
            if let Some(d1) = &self.d1 {
                // Use per-device watermark stored in D1's sync_manifest table.
                let watermark = d1
                    .get_watermark(device_id)
                    .await?
                    .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());

                for &table in &d1_tables {
                    let rows = d1.query_since(table, &watermark, device_id).await?;
                    if rows.is_empty() {
                        continue;
                    }
                    let count = rows.len() as u64;
                    // Write into local DuckDB as a proxy (no local SQLite yet —
                    // future iteration adds a separate SQLite file for OLTP tables).
                    // For now we record what was pulled for observability.
                    info!(table, count, "pulled from D1");
                    result.total_rows += count;
                    result.tables.push(SyncTableResult {
                        table: table.to_string(),
                        row_count: count,
                        parquet_path: format!("d1://{table}"),
                    });
                }

                if result.total_rows > 0 {
                    let now = Utc::now().to_rfc3339();
                    d1.set_watermark(device_id, &now).await?;
                }
            } else {
                warn!("D1 tables requested but D1 is not configured — skipping");
            }
        }

        // ── R2 pull (DuckDB tables) ──────────────────────────────────────────
        let r2_tables: Vec<&str> = tables
            .iter()
            .copied()
            .filter(|t| SYNCABLE_TABLES.contains(t))
            .collect();
        if !r2_tables.is_empty() {
            // Load remote manifest.
            let manifest_key = format!("{}/manifest.json", self.workspace_id);
            let manifest_bytes = match self.r2.get_object(&manifest_key).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    warn!("no remote manifest found, nothing to pull from R2");
                    return Ok(result);
                }
            };

            let remote_manifest: SyncManifest = serde_json::from_slice(&manifest_bytes)
                .map_err(|e| SyncError::Manifest(format!("parse remote manifest: {e}")))?;

            let local_manifest = manifest::load_local(
                &self.sync_dir,
                &self.workspace_id,
                device_id,
            )
            .await?;

            let last_pull_ts = local_manifest.last_pull.as_ref().map(|e| e.timestamp);

            for push_entry in &remote_manifest.pushes {
                if push_entry.device_id == *device_id {
                    continue;
                }
                if let Some(ts) = last_pull_ts {
                    if push_entry.timestamp <= ts {
                        continue;
                    }
                }

                for table_result in &push_entry.tables {
                    if !r2_tables.contains(&table_result.table.as_str()) {
                        continue;
                    }

                    let local_path = self.sync_dir.join("pull").join(&table_result.parquet_path);
                    self.r2.download_file(&table_result.parquet_path, &local_path).await?;

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
        }

        Ok(result)
    }

    async fn status(&self) -> Result<SyncStatus, SyncError> {
        let device_id = &self.config.device_id;

        // DuckDB pending counts (OLAP tables).
        let pending = {
            let conn = self.conn.lock().unwrap();
            SyncPendingRows {
                sessions: parquet_export::pending_count(&conn, "sessions").unwrap_or(0),
                spans: parquet_export::pending_count(&conn, "spans").unwrap_or(0),
                traffic: parquet_export::pending_count(&conn, "traffic").unwrap_or(0),
                tasks: 0, // tasks now lives in SQLite→D1
                context: 0,
            }
        };

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

        let r2_reachable = if self.config.enabled {
            Some(self.r2.health_check().await)
        } else {
            None
        };

        let d1_reachable = if self.config.d1_enabled() {
            if let Some(d1) = &self.d1 {
                Some(d1.health_check().await)
            } else {
                None
            }
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
            d1_reachable,
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
            d1_database_id: String::new(),
            d1_account_id: String::new(),
            d1_api_token: String::new(),
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
        let mut expected: Vec<&str> = SYNCABLE_TABLES.to_vec();
        expected.extend_from_slice(D1_SYNCABLE_TABLES);
        assert_eq!(tables, expected);
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
        // DuckDB tables (OLAP). tasks is now SQLite→D1, not DuckDB.
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);",
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
        assert!(status.d1_reachable.is_none()); // D1 not configured
    }

    #[tokio::test]
    async fn status_counts_pending_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
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
        assert_eq!(status.pending_rows.tasks, 0); // tasks is now D1
    }
}
