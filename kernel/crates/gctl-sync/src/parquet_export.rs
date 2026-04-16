//! Parquet export — DuckDB COPY to Parquet for unsynced rows.
//!
//! Uses DuckDB's native `COPY ... TO ... (FORMAT PARQUET)` which leverages
//! the built-in Arrow/Parquet support for zero-copy export.

use duckdb::Connection;
use std::path::{Path, PathBuf};
use tracing::debug;

use crate::SyncError;

/// DuckDB tables synced to R2 via Parquet (OLAP: telemetry).
/// Note: `tasks` moved to SQLite→D1 per spec/sync-sqlite-d1.
pub const SYNCABLE_TABLES: &[&str] = &["sessions", "spans", "traffic"];

/// Export unsynced rows from a table to a Parquet file using DuckDB's COPY.
///
/// Returns the number of rows exported. If no unsynced rows exist, no file is
/// written and 0 is returned.
pub fn export_table(
    conn: &Connection,
    table: &str,
    output_path: &Path,
) -> Result<u64, SyncError> {
    validate_table_name(table)?;

    // Count unsynced rows first to avoid writing empty files.
    let count: u64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE synced = FALSE"),
            [],
            |row| row.get(0),
        )
        .map_err(|e| SyncError::Export(format!("count {table}: {e}")))?;

    if count == 0 {
        debug!(table, "no unsynced rows, skipping export");
        return Ok(0);
    }

    // Ensure parent directory exists.
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SyncError::Io(format!("mkdir {}: {e}", parent.display())))?;
    }

    let path_str = output_path.to_string_lossy();
    let sql = format!(
        "COPY (SELECT * FROM {table} WHERE synced = FALSE) TO '{path_str}' (FORMAT PARQUET)"
    );
    conn.execute_batch(&sql)
        .map_err(|e| SyncError::Export(format!("COPY {table}: {e}")))?;

    debug!(table, count, path = %path_str, "exported to Parquet");
    Ok(count)
}

/// Mark rows as synced after a successful push.
pub fn mark_synced(
    conn: &Connection,
    table: &str,
) -> Result<u64, SyncError> {
    validate_table_name(table)?;
    let updated = conn
        .execute(
            &format!("UPDATE {table} SET synced = TRUE WHERE synced = FALSE"),
            [],
        )
        .map_err(|e| SyncError::Export(format!("mark synced {table}: {e}")))?;
    debug!(table, updated, "marked rows synced");
    Ok(updated as u64)
}

/// Count unsynced rows for a table.
pub fn pending_count(conn: &Connection, table: &str) -> Result<u64, SyncError> {
    validate_table_name(table)?;
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE synced = FALSE"),
        [],
        |row| row.get(0),
    )
    .map_err(|e| SyncError::Export(format!("pending count {table}: {e}")))
}

/// Build the staging path for a table export.
pub fn staging_path(
    sync_dir: &Path,
    device_id: &str,
    table: &str,
    date: &str,
    push_id: &str,
) -> PathBuf {
    sync_dir
        .join(device_id)
        .join(table)
        .join(date)
        .join(format!("{push_id}.parquet"))
}

/// Validate table name against the allowlist to prevent SQL injection.
fn validate_table_name(table: &str) -> Result<(), SyncError> {
    if SYNCABLE_TABLES.contains(&table) {
        Ok(())
    } else {
        Err(SyncError::Export(format!(
            "table '{table}' is not syncable (allowed: {SYNCABLE_TABLES:?})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_table_name_rejects_unknown() {
        assert!(validate_table_name("sessions").is_ok());
        assert!(validate_table_name("spans").is_ok());
        assert!(validate_table_name("traffic").is_ok());
        // tasks moved to SQLite→D1, no longer in DuckDB SYNCABLE_TABLES
        assert!(validate_table_name("tasks").is_err());
        assert!(validate_table_name("users").is_err());
        assert!(validate_table_name("'; DROP TABLE sessions; --").is_err());
    }

    #[test]
    fn staging_path_structure() {
        let dir = PathBuf::from("/tmp/sync");
        let path = staging_path(&dir, "dev1", "sessions", "2026-04-06", "push-abc");
        assert_eq!(
            path,
            PathBuf::from("/tmp/sync/dev1/sessions/2026-04-06/push-abc.parquet")
        );
    }

    #[test]
    fn export_empty_table_returns_zero() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id VARCHAR PRIMARY KEY,
                workspace_id VARCHAR,
                device_id VARCHAR,
                agent_name VARCHAR,
                started_at VARCHAR,
                ended_at VARCHAR,
                status VARCHAR DEFAULT 'active',
                total_cost_usd DOUBLE DEFAULT 0.0,
                total_input_tokens BIGINT DEFAULT 0,
                total_output_tokens BIGINT DEFAULT 0,
                synced BOOLEAN DEFAULT FALSE
            )"
        ).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.parquet");
        let count = export_table(&conn, "sessions", &path).unwrap();
        assert_eq!(count, 0);
        assert!(!path.exists()); // no file written for empty export
    }

    #[test]
    fn export_and_mark_synced() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id VARCHAR PRIMARY KEY,
                workspace_id VARCHAR,
                device_id VARCHAR,
                agent_name VARCHAR,
                started_at VARCHAR,
                ended_at VARCHAR,
                status VARCHAR DEFAULT 'active',
                total_cost_usd DOUBLE DEFAULT 0.0,
                total_input_tokens BIGINT DEFAULT 0,
                total_output_tokens BIGINT DEFAULT 0,
                synced BOOLEAN DEFAULT FALSE
            );
            INSERT INTO sessions (id, workspace_id, device_id, agent_name, started_at, status)
                VALUES ('s1', 'ws1', 'dev1', 'claude', '2026-04-06T00:00:00Z', 'completed');
            INSERT INTO sessions (id, workspace_id, device_id, agent_name, started_at, status)
                VALUES ('s2', 'ws1', 'dev1', 'claude', '2026-04-06T01:00:00Z', 'active');
            "
        ).unwrap();

        // Export
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.parquet");
        let count = export_table(&conn, "sessions", &path).unwrap();
        assert_eq!(count, 2);
        assert!(path.exists());

        // Pending count before marking
        assert_eq!(pending_count(&conn, "sessions").unwrap(), 2);

        // Mark synced
        let marked = mark_synced(&conn, "sessions").unwrap();
        assert_eq!(marked, 2);

        // Pending count after marking
        assert_eq!(pending_count(&conn, "sessions").unwrap(), 0);

        // Second export should return 0
        let path2 = dir.path().join("sessions2.parquet");
        let count2 = export_table(&conn, "sessions", &path2).unwrap();
        assert_eq!(count2, 0);
    }
}
