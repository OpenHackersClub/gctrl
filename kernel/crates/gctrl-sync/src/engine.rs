//! SyncEngine — orchestrates dual-path sync:
//!   DuckDB → R2 (Parquet) for OLAP telemetry tables
//!   SQLite  → D1 (row-level) for OLTP board/task tables
//!
//! See `specs/architecture/kernel/sync.md` for the full design.

use async_trait::async_trait;
use chrono::Utc;
use duckdb::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tracing::{info, warn};
use uuid::Uuid;

use gctrl_core::{
    SyncConfig, SyncManifest, SyncManifestEntry, SyncPendingRows, SyncResult, SyncStatus,
    SyncTableResult,
};
use gctrl_storage::SqliteStore;

use crate::d1::{sqlite_to_d1_table, D1Client, SQLITE_SYNCABLE_TABLES};
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
    /// Optional SQLite store. Required to push OLTP tables (e.g. `memory_entries`)
    /// that originate in SQLite rather than DuckDB. Without it, those tables skip sync.
    sqlite: Option<Arc<SqliteStore>>,
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
            sqlite: None,
            config,
            sync_dir,
            workspace_id,
        }
    }

    /// Attach a SQLite store so OLTP tables (e.g. `memory_entries`) can be pushed to D1.
    pub fn with_sqlite(mut self, sqlite: Arc<SqliteStore>) -> Self {
        self.sqlite = Some(sqlite);
        self
    }

    /// Resolve which tables to sync: if `tables` is empty, use all syncable tables
    /// (both R2/DuckDB and D1/SQLite sets).
    fn resolve_tables<'a>(&self, tables: &'a [&'a str]) -> Vec<&'a str> {
        if tables.is_empty() {
            let mut all: Vec<&str> = SYNCABLE_TABLES.to_vec();
            all.extend_from_slice(SQLITE_SYNCABLE_TABLES);
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
    /// Routing:
    ///   - `memory_entries` → SQLite (via `self.sqlite`, the canonical path for OLTP rows)
    ///   - `tasks`          → DuckDB (legacy interim store)
    ///   - everything else  → no-op (board tables are written directly by the Worker)
    async fn push_table_to_d1(
        &self,
        table: &str,
        _device_id: &str,
    ) -> Result<u64, SyncError> {
        let Some(d1) = &self.d1 else {
            warn!(table, "D1 push requested but D1 not configured — skipping");
            return Ok(0);
        };

        if table == "memory_entries" {
            let Some(sqlite) = &self.sqlite else {
                warn!(table, "memory_entries push skipped — SQLite store not attached");
                return Ok(0);
            };

            // Batch size matches D1's practical statement limit.
            let pending = sqlite
                .list_unsynced_memories(100)
                .map_err(|e| SyncError::Export(format!("list unsynced memories: {e}")))?;

            if pending.is_empty() {
                return Ok(0);
            }

            let rows: Vec<crate::d1::D1Row> = pending
                .iter()
                .map(|m| {
                    let mut row = crate::d1::D1Row::new();
                    row.insert("id".into(), serde_json::Value::String(m.id.0.clone()));
                    row.insert(
                        "type".into(),
                        serde_json::Value::String(m.memory_type.as_str().to_string()),
                    );
                    row.insert("name".into(), serde_json::Value::String(m.name.clone()));
                    row.insert(
                        "description".into(),
                        serde_json::Value::String(m.description.clone()),
                    );
                    row.insert("body".into(), serde_json::Value::String(m.body.clone()));
                    row.insert(
                        "tags".into(),
                        serde_json::Value::String(
                            serde_json::to_string(&m.tags).unwrap_or_else(|_| "[]".into()),
                        ),
                    );
                    row.insert(
                        "device_id".into(),
                        serde_json::Value::String(m.device_id.clone()),
                    );
                    row.insert(
                        "created_at".into(),
                        serde_json::Value::String(m.created_at.to_rfc3339()),
                    );
                    row.insert(
                        "updated_at".into(),
                        serde_json::Value::String(m.updated_at.to_rfc3339()),
                    );
                    // D1 row goes in as synced=1 (it's now the canonical remote copy).
                    row.insert("synced".into(), serde_json::Value::Number(1.into()));
                    row
                })
                .collect();

            let count = d1.batch_upsert(table, &rows).await?;

            let ids: Vec<String> = pending.iter().map(|m| m.id.0.clone()).collect();
            sqlite
                .mark_memories_synced(&ids)
                .map_err(|e| SyncError::Export(format!("mark memories synced: {e}")))?;

            return Ok(count);
        }

        if matches!(
            table,
            "board_projects" | "board_issues" | "board_comments" | "board_events"
        ) {
            let Some(sqlite) = &self.sqlite else {
                warn!(table, "board push skipped — SQLite store not attached");
                return Ok(0);
            };
            let d1_table = sqlite_to_d1_table(table);
            let device_id = sqlite.device_id().to_string();
            let now = chrono::Utc::now().to_rfc3339();

            let (rows, ids) = match table {
                "board_projects" => {
                    let pending = sqlite
                        .list_unsynced_board_projects(100)
                        .map_err(|e| SyncError::Export(format!("list unsynced projects: {e}")))?;
                    if pending.is_empty() {
                        return Ok(0);
                    }
                    let ids: Vec<String> = pending.iter().map(|p| p.id.clone()).collect();
                    let rows: Vec<crate::d1::D1Row> = pending
                        .into_iter()
                        .map(|p| {
                            let mut row = crate::d1::D1Row::new();
                            row.insert("id".into(), serde_json::Value::String(p.id));
                            row.insert("name".into(), serde_json::Value::String(p.name));
                            row.insert("key".into(), serde_json::Value::String(p.key));
                            row.insert(
                                "counter".into(),
                                serde_json::Value::Number(serde_json::Number::from(p.counter)),
                            );
                            row.insert(
                                "github_repo".into(),
                                p.github_repo.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert("device_id".into(), serde_json::Value::String(device_id.clone()));
                            row.insert("updated_at".into(), serde_json::Value::String(now.clone()));
                            row.insert("synced".into(), serde_json::Value::Number(1.into()));
                            row
                        })
                        .collect();
                    (rows, ids)
                }
                "board_issues" => {
                    let pending = sqlite
                        .list_unsynced_board_issues(100)
                        .map_err(|e| SyncError::Export(format!("list unsynced issues: {e}")))?;
                    if pending.is_empty() {
                        return Ok(0);
                    }
                    let ids: Vec<String> = pending.iter().map(|i| i.id.clone()).collect();
                    let rows: Vec<crate::d1::D1Row> = pending
                        .into_iter()
                        .map(|i| {
                            let mut row = crate::d1::D1Row::new();
                            row.insert("id".into(), serde_json::Value::String(i.id));
                            row.insert("project_id".into(), serde_json::Value::String(i.project_id));
                            row.insert("title".into(), serde_json::Value::String(i.title));
                            row.insert(
                                "description".into(),
                                i.description.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert("status".into(), serde_json::Value::String(i.status.as_str().to_string()));
                            row.insert("priority".into(), serde_json::Value::String(i.priority));
                            row.insert(
                                "assignee_id".into(),
                                i.assignee_id.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert(
                                "assignee_name".into(),
                                i.assignee_name.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert(
                                "assignee_type".into(),
                                i.assignee_type.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert(
                                "labels".into(),
                                serde_json::Value::String(serde_json::to_string(&i.labels).unwrap_or_else(|_| "[]".into())),
                            );
                            row.insert(
                                "parent_id".into(),
                                i.parent_id.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert("created_at".into(), serde_json::Value::String(i.created_at.to_rfc3339()));
                            row.insert("updated_at".into(), serde_json::Value::String(i.updated_at.to_rfc3339()));
                            row.insert("created_by_id".into(), serde_json::Value::String(i.created_by_id));
                            row.insert("created_by_name".into(), serde_json::Value::String(i.created_by_name));
                            row.insert("created_by_type".into(), serde_json::Value::String(i.created_by_type));
                            row.insert(
                                "blocked_by".into(),
                                serde_json::Value::String(serde_json::to_string(&i.blocked_by).unwrap_or_else(|_| "[]".into())),
                            );
                            row.insert(
                                "blocking".into(),
                                serde_json::Value::String(serde_json::to_string(&i.blocking).unwrap_or_else(|_| "[]".into())),
                            );
                            row.insert(
                                "session_ids".into(),
                                serde_json::Value::String(serde_json::to_string(&i.session_ids).unwrap_or_else(|_| "[]".into())),
                            );
                            row.insert(
                                "total_cost_usd".into(),
                                serde_json::Number::from_f64(i.total_cost_usd)
                                    .map(serde_json::Value::Number)
                                    .unwrap_or(serde_json::Value::Null),
                            );
                            row.insert(
                                "total_tokens".into(),
                                serde_json::Value::Number(serde_json::Number::from(i.total_tokens)),
                            );
                            row.insert(
                                "pr_numbers".into(),
                                serde_json::Value::String(serde_json::to_string(&i.pr_numbers).unwrap_or_else(|_| "[]".into())),
                            );
                            row.insert(
                                "github_issue_number".into(),
                                i.github_issue_number
                                    .map(|n| serde_json::Value::Number(serde_json::Number::from(n)))
                                    .unwrap_or(serde_json::Value::Null),
                            );
                            row.insert(
                                "github_url".into(),
                                i.github_url.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            // SQLite-only fields content_hash and source_path are stripped — they're
                            // local provenance, not part of the D1 schema.
                            row.insert("device_id".into(), serde_json::Value::String(device_id.clone()));
                            row.insert("synced".into(), serde_json::Value::Number(1.into()));
                            row
                        })
                        .collect();
                    (rows, ids)
                }
                "board_comments" => {
                    let pending = sqlite
                        .list_unsynced_board_comments(100)
                        .map_err(|e| SyncError::Export(format!("list unsynced comments: {e}")))?;
                    if pending.is_empty() {
                        return Ok(0);
                    }
                    let ids: Vec<String> = pending.iter().map(|c| c.id.clone()).collect();
                    let rows: Vec<crate::d1::D1Row> = pending
                        .into_iter()
                        .map(|c| {
                            let mut row = crate::d1::D1Row::new();
                            row.insert("id".into(), serde_json::Value::String(c.id));
                            row.insert("issue_id".into(), serde_json::Value::String(c.issue_id));
                            row.insert("author_id".into(), serde_json::Value::String(c.author_id));
                            row.insert("author_name".into(), serde_json::Value::String(c.author_name));
                            row.insert("author_type".into(), serde_json::Value::String(c.author_type));
                            row.insert("body".into(), serde_json::Value::String(c.body));
                            row.insert("created_at".into(), serde_json::Value::String(c.created_at.to_rfc3339()));
                            row.insert(
                                "session_id".into(),
                                c.session_id.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                            );
                            row.insert("device_id".into(), serde_json::Value::String(device_id.clone()));
                            row.insert("updated_at".into(), serde_json::Value::String(c.created_at.to_rfc3339()));
                            row.insert("synced".into(), serde_json::Value::Number(1.into()));
                            row
                        })
                        .collect();
                    (rows, ids)
                }
                "board_events" => {
                    let pending = sqlite
                        .list_unsynced_board_events(100)
                        .map_err(|e| SyncError::Export(format!("list unsynced events: {e}")))?;
                    if pending.is_empty() {
                        return Ok(0);
                    }
                    let ids: Vec<String> = pending.iter().map(|e| e.id.clone()).collect();
                    let rows: Vec<crate::d1::D1Row> = pending
                        .into_iter()
                        .map(|e| {
                            let mut row = crate::d1::D1Row::new();
                            row.insert("id".into(), serde_json::Value::String(e.id));
                            row.insert("issue_id".into(), serde_json::Value::String(e.issue_id));
                            // SQLite column `type` → D1 column `event_type`.
                            row.insert("event_type".into(), serde_json::Value::String(e.event_type));
                            row.insert("actor_id".into(), serde_json::Value::String(e.actor_id));
                            row.insert("actor_name".into(), serde_json::Value::String(e.actor_name));
                            row.insert("actor_type".into(), serde_json::Value::String(e.actor_type));
                            row.insert("timestamp".into(), serde_json::Value::String(e.timestamp.to_rfc3339()));
                            row.insert(
                                "data".into(),
                                serde_json::Value::String(e.data.to_string()),
                            );
                            row.insert("device_id".into(), serde_json::Value::String(device_id.clone()));
                            row.insert("updated_at".into(), serde_json::Value::String(e.timestamp.to_rfc3339()));
                            row.insert("synced".into(), serde_json::Value::Number(1.into()));
                            row
                        })
                        .collect();
                    (rows, ids)
                }
                _ => unreachable!("matches! gate above"),
            };

            let count = d1.batch_upsert(d1_table, &rows).await?;

            match table {
                "board_projects" => sqlite.mark_board_projects_synced(&ids),
                "board_issues" => sqlite.mark_board_issues_synced(&ids),
                "board_comments" => sqlite.mark_board_comments_synced(&ids),
                "board_events" => sqlite.mark_board_events_synced(&ids),
                _ => unreachable!(),
            }
            .map_err(|e| SyncError::Export(format!("mark board synced: {e}")))?;

            return Ok(count);
        }

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
            // Route: SQLITE_SYNCABLE_TABLES → D1, everything else → R2/Parquet.
            if SQLITE_SYNCABLE_TABLES.contains(&table) {
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
            .filter(|t| SQLITE_SYNCABLE_TABLES.contains(t))
            .collect();
        if !d1_tables.is_empty() {
            if let Some(d1) = &self.d1 {
                // Use per-device watermark stored in D1's sync_manifest table.
                let watermark = d1
                    .get_watermark(device_id)
                    .await?
                    .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());

                for &table in &d1_tables {
                    // D1 uses unprefixed names; translate before querying.
                    let d1_table = sqlite_to_d1_table(table);
                    let rows = d1.query_since(d1_table, &watermark, device_id).await?;
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
                local_manifest.last_pull = Some(gctrl_core::SyncEvent {
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
        let mut pending = {
            let conn = self.conn.lock().unwrap();
            SyncPendingRows {
                sessions: parquet_export::pending_count(&conn, "sessions").unwrap_or(0),
                spans: parquet_export::pending_count(&conn, "spans").unwrap_or(0),
                traffic: parquet_export::pending_count(&conn, "traffic").unwrap_or(0),
                tasks: 0, // tasks now lives in SQLite→D1
                context: 0,
                memory: 0,
                board_projects: 0,
                board_issues: 0,
                board_comments: 0,
                board_events: 0,
            }
        };

        // SQLite pending counts (OLTP tables).
        if let Some(sqlite) = &self.sqlite {
            if let Ok(stats) = sqlite.get_memory_stats() {
                pending.memory = stats.unsynced;
            }
            if let Ok((projects, issues, comments, events)) = sqlite.count_unsynced_board() {
                pending.board_projects = projects;
                pending.board_issues = issues;
                pending.board_comments = comments;
                pending.board_events = events;
            }
        }

        let manifest = manifest::load_local(
            &self.sync_dir,
            &self.workspace_id,
            device_id,
        )
        .await?;

        let last_push = manifest.pushes.last().map(|entry| gctrl_core::SyncEvent {
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
        expected.extend_from_slice(SQLITE_SYNCABLE_TABLES);
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

    #[tokio::test]
    async fn status_counts_memory_pending_when_sqlite_attached() {
        use gctrl_core::{MemoryEntry, MemoryEntryId, MemoryType};
        use gctrl_storage::SqliteStore;
        use std::sync::Arc;

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);",
        )
        .unwrap();

        let sqlite = Arc::new(SqliteStore::open(":memory:").unwrap());
        let now = chrono::Utc::now();
        for i in 0..2 {
            sqlite
                .upsert_memory(&MemoryEntry {
                    id: MemoryEntryId(format!("mem-t{i}")),
                    memory_type: MemoryType::Feedback,
                    name: format!("m{i}"),
                    description: String::new(),
                    body: String::new(),
                    tags: vec![],
                    device_id: "dev-x".into(),
                    created_at: now,
                    updated_at: now,
                    synced: false,
                })
                .unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        )
        .with_sqlite(sqlite);

        let status = engine.status().await.unwrap();
        assert_eq!(status.pending_rows.memory, 2);
    }

    #[tokio::test]
    async fn status_counts_board_pending_when_sqlite_attached() {
        use gctrl_core::{BoardIssue, BoardProject, IssueStatus};
        use gctrl_storage::SqliteStore;
        use std::sync::Arc;

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE spans (id VARCHAR, synced BOOLEAN DEFAULT FALSE);
             CREATE TABLE traffic (id VARCHAR, synced BOOLEAN DEFAULT FALSE);",
        )
        .unwrap();

        let sqlite = Arc::new(SqliteStore::open_with_device(":memory:", "dev-x").unwrap());
        sqlite.create_board_project(&BoardProject {
            id: "p1".into(),
            name: "P".into(),
            key: "P".into(),
            counter: 0,
            github_repo: None,
        }).unwrap();
        let now = chrono::Utc::now();
        for i in 0..3 {
            sqlite.insert_board_issue(&BoardIssue {
                id: format!("P-{i}"),
                project_id: "p1".into(),
                title: format!("Issue {i}"),
                description: None,
                status: IssueStatus::Backlog,
                priority: "none".into(),
                assignee_id: None, assignee_name: None, assignee_type: None,
                labels: vec![],
                parent_id: None,
                created_at: now, updated_at: now,
                created_by_id: "u".into(), created_by_name: "u".into(), created_by_type: "human".into(),
                blocked_by: vec![], blocking: vec![], session_ids: vec![],
                total_cost_usd: 0.0, total_tokens: 0, pr_numbers: vec![],
                content_hash: None, source_path: None,
                github_issue_number: None, github_url: None,
            }).unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let engine = R2SyncEngine::new(
            conn,
            test_config(),
            dir.path().to_path_buf(),
            "ws1".into(),
        )
        .with_sqlite(sqlite);

        let status = engine.status().await.unwrap();
        assert_eq!(status.pending_rows.board_projects, 1);
        assert_eq!(status.pending_rows.board_issues, 3);
        assert_eq!(status.pending_rows.board_comments, 0);
        assert_eq!(status.pending_rows.board_events, 0);
    }
}
