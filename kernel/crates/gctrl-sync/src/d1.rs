//! D1 HTTP client — syncs SQLite tables to Cloudflare D1 via the REST API.
//!
//! Cloudflare D1 REST API:
//!   POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query
//!
//! Each table being synced must have:
//!   - `id TEXT PRIMARY KEY`
//!   - `device_id TEXT`
//!   - `updated_at TEXT`
//!   - `synced INTEGER DEFAULT 0`
//!
//! Push: INSERT OR REPLACE unsynced rows into D1.
//! Pull: SELECT rows WHERE updated_at > {watermark} AND device_id != {our_device_id}.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tracing::{debug, warn};

use crate::SyncError;

const D1_API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// Cloudflare D1 HTTP client.
#[derive(Debug, Clone)]
pub struct D1Client {
    client: Client,
    account_id: String,
    database_id: String,
    api_token: String,
}

/// A row returned from a D1 query — column name → JSON value.
pub type D1Row = HashMap<String, serde_json::Value>;

#[derive(Debug, Serialize)]
struct D1QueryRequest {
    sql: String,
    params: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct D1ApiResponse {
    success: bool,
    errors: Vec<D1ApiError>,
    result: Option<Vec<D1QueryResult>>,
}

#[derive(Debug, Deserialize)]
struct D1ApiError {
    #[allow(dead_code)]
    code: u32,
    message: String,
}

#[derive(Debug, Deserialize)]
struct D1QueryResult {
    results: Option<Vec<D1Row>>,
    #[serde(default)]
    #[allow(dead_code)]
    rows_written: u64,
}

impl D1Client {
    pub fn new(account_id: &str, database_id: &str, api_token: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            account_id: account_id.to_string(),
            database_id: database_id.to_string(),
            api_token: api_token.to_string(),
        }
    }

    fn query_url(&self) -> String {
        format!(
            "{}/accounts/{}/d1/database/{}/query",
            D1_API_BASE, self.account_id, self.database_id
        )
    }

    /// Execute a single SQL statement against D1 with retry on 429.
    async fn execute(
        &self,
        sql: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<Vec<D1Row>, SyncError> {
        let url = self.query_url();
        let body = D1QueryRequest {
            sql: sql.to_string(),
            params,
        };

        let mut attempts = 0u32;
        loop {
            attempts += 1;
            let resp = self
                .client
                .post(&url)
                .bearer_auth(&self.api_token)
                .json(&body)
                .send()
                .await
                .map_err(|e| SyncError::R2(format!("D1 request: {e}")))?;

            // Rate limit — respect Retry-After header.
            if resp.status().as_u16() == 429 {
                if attempts >= 3 {
                    return Err(SyncError::R2("D1 rate limit exceeded after 3 retries".into()));
                }
                let wait_secs = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(5);
                warn!(wait_secs, "D1 rate limited, backing off");
                tokio::time::sleep(Duration::from_secs(wait_secs)).await;
                continue;
            }

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(SyncError::R2(format!("D1 HTTP {status}: {text}")));
            }

            let api_resp: D1ApiResponse = resp
                .json()
                .await
                .map_err(|e| SyncError::R2(format!("D1 parse response: {e}")))?;

            if !api_resp.success {
                let msgs: Vec<_> = api_resp.errors.iter().map(|e| e.message.as_str()).collect();
                return Err(SyncError::R2(format!("D1 error: {}", msgs.join(", "))));
            }

            let rows = api_resp
                .result
                .and_then(|mut r| r.pop())
                .and_then(|r| r.results)
                .unwrap_or_default();

            return Ok(rows);
        }
    }

    /// Push rows into D1 using INSERT OR REPLACE.
    ///
    /// `rows` — each row is a map of column→value. All rows must have the same columns.
    /// Rows are sent in batches of 100 to stay within D1 statement limits.
    pub async fn batch_upsert(
        &self,
        table: &str,
        rows: &[D1Row],
    ) -> Result<u64, SyncError> {
        if rows.is_empty() {
            return Ok(0);
        }

        validate_table_name(table)?;

        let cols: Vec<String> = rows[0].keys().cloned().collect();
        let placeholders = cols.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let col_list = cols.join(", ");
        let sql = format!(
            "INSERT OR REPLACE INTO {table} ({col_list}) VALUES ({placeholders})"
        );

        let mut total_written = 0u64;
        for chunk in rows.chunks(100) {
            for row in chunk {
                let params: Vec<serde_json::Value> =
                    cols.iter().map(|c| row.get(c).cloned().unwrap_or(serde_json::Value::Null)).collect();
                self.execute(&sql, params).await?;
                total_written += 1;
            }
        }

        debug!(table, total_written, "D1 batch upsert done");
        Ok(total_written)
    }

    /// Query rows from D1 updated after `watermark` by devices other than `device_id`.
    ///
    /// `watermark` — ISO 8601 timestamp string (e.g. "2026-04-06T12:00:00Z").
    pub async fn query_since(
        &self,
        table: &str,
        watermark: &str,
        device_id: &str,
    ) -> Result<Vec<D1Row>, SyncError> {
        validate_table_name(table)?;
        let sql = format!(
            "SELECT * FROM {table} WHERE updated_at > ? AND device_id != ? ORDER BY updated_at ASC"
        );
        let rows = self
            .execute(
                &sql,
                vec![
                    serde_json::Value::String(watermark.to_string()),
                    serde_json::Value::String(device_id.to_string()),
                ],
            )
            .await?;
        debug!(table, watermark, count = rows.len(), "D1 query_since");
        Ok(rows)
    }

    /// Check D1 reachability by running a trivial query.
    pub async fn health_check(&self) -> bool {
        match self.execute("SELECT 1 AS ok", vec![]).await {
            Ok(_) => true,
            Err(e) => {
                warn!(error = %e, "D1 health check failed");
                false
            }
        }
    }

    /// Read the pull watermark for a given device from the `sync_manifest` table.
    pub async fn get_watermark(&self, device_id: &str) -> Result<Option<String>, SyncError> {
        let rows = self
            .execute(
                "SELECT last_pull_at FROM sync_manifest WHERE device_id = ?",
                vec![serde_json::Value::String(device_id.to_string())],
            )
            .await?;
        Ok(rows
            .into_iter()
            .next()
            .and_then(|r| r.get("last_pull_at").and_then(|v| v.as_str().map(String::from))))
    }

    /// Upsert the pull watermark for a device in the `sync_manifest` table.
    pub async fn set_watermark(&self, device_id: &str, timestamp: &str) -> Result<(), SyncError> {
        self.execute(
            "INSERT OR REPLACE INTO sync_manifest (device_id, last_pull_at) VALUES (?, ?)",
            vec![
                serde_json::Value::String(device_id.to_string()),
                serde_json::Value::String(timestamp.to_string()),
            ],
        )
        .await?;
        Ok(())
    }
}

/// Validate table name against the D1 syncable allowlist (SQL injection guard).
pub fn validate_table_name(table: &str) -> Result<(), SyncError> {
    if D1_SYNCABLE_TABLES.contains(&table) {
        Ok(())
    } else {
        Err(SyncError::R2(format!(
            "table '{table}' is not D1-syncable (allowed: {D1_SYNCABLE_TABLES:?})"
        )))
    }
}

/// Tables as named in D1 (Cloudflare side). Used to validate SQL targets.
///
/// All tables here MUST carry the sync contract columns:
/// `id TEXT PRIMARY KEY`, `device_id TEXT`, `updated_at TEXT`, `synced INTEGER`.
pub const D1_SYNCABLE_TABLES: &[&str] =
    &["projects", "issues", "comments", "issue_events", "tasks", "memory_entries"];

/// Tables as named in the local SQLite store. These are what callers pass into
/// `SyncEngine::push`. Routing uses this list; the D1 translator below maps
/// each one to its D1-side name.
pub const SQLITE_SYNCABLE_TABLES: &[&str] = &[
    "board_projects",
    "board_issues",
    "board_comments",
    "board_events",
    "tasks",
    "memory_entries",
];

/// Translate a SQLite table name to its D1 counterpart.
///
/// SQLite uses `board_*` prefixes (co-located with non-syncable tables in the
/// same database). D1 uses unprefixed names because the board is its own
/// database namespace. Tables that aren't board tables map to themselves.
pub fn sqlite_to_d1_table(sqlite_table: &str) -> &str {
    match sqlite_table {
        "board_projects" => "projects",
        "board_issues" => "issues",
        "board_comments" => "comments",
        "board_events" => "issue_events",
        other => other,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_table_allows_known() {
        assert!(validate_table_name("projects").is_ok());
        assert!(validate_table_name("issues").is_ok());
        assert!(validate_table_name("tasks").is_ok());
        assert!(validate_table_name("memory_entries").is_ok());
    }

    #[test]
    fn validate_table_rejects_unknown() {
        assert!(validate_table_name("sessions").is_err());
        assert!(validate_table_name("'; DROP TABLE projects; --").is_err());
    }

    #[test]
    fn d1_client_builds_correct_url() {
        let client = D1Client::new("acct123", "db456", "tok");
        assert_eq!(
            client.query_url(),
            "https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/db456/query"
        );
    }
}
