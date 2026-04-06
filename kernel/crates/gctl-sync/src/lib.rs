//! gctl-sync — R2 sync engine for local-first, cloud-optional telemetry sync.
//!
//! Exports unsynced DuckDB rows as Parquet, uploads to Cloudflare R2 via
//! S3-compatible API, and imports remote Parquet files from other devices.
//!
//! See `specs/architecture/kernel/sync.md` for the full design.

pub mod engine;
pub mod manifest;
pub mod parquet_export;
pub mod r2;

pub use engine::{R2SyncEngine, SyncEngine};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("export error: {0}")]
    Export(String),

    #[error("import error: {0}")]
    Import(String),

    #[error("R2 error: {0}")]
    R2(String),

    #[error("manifest error: {0}")]
    Manifest(String),

    #[error("I/O error: {0}")]
    Io(String),
}

impl From<SyncError> for gctl_core::GctlError {
    fn from(e: SyncError) -> Self {
        gctl_core::GctlError::Sync(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_error_converts_to_gctl_error() {
        let err = SyncError::R2("connection refused".into());
        let gctl_err: gctl_core::GctlError = err.into();
        assert!(gctl_err.to_string().contains("connection refused"));
    }

    #[test]
    fn sync_error_display() {
        let err = SyncError::Export("table not found".into());
        assert_eq!(err.to_string(), "export error: table not found");
    }
}
