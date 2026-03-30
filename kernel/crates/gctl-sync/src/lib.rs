//! R2 sync engine: Parquet export from DuckDB, upload to Cloudflare R2.
//! Phase 4: Will use arrow + parquet crates for export and S3-compatible API for upload.

pub struct SyncStatus {
    pub last_push: Option<String>,
    pub pending_rows: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_status() {
        let status = SyncStatus {
            last_push: None,
            pending_rows: 0,
        };
        assert!(status.last_push.is_none());
    }
}
