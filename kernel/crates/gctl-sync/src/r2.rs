//! R2 client — S3-compatible upload/download to Cloudflare R2.
//!
//! Uses reqwest with AWS Signature V4 style auth headers.
//! R2 supports the S3 PutObject/GetObject/ListObjectsV2 API subset.

use chrono::Utc;
use reqwest::Client;
use std::path::Path;
use tokio::fs;
use tracing::{debug, warn};

use crate::SyncError;

/// S3-compatible client for Cloudflare R2.
#[derive(Debug, Clone)]
pub struct R2Client {
    client: Client,
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
}

impl R2Client {
    pub fn new(
        endpoint: &str,
        bucket: &str,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Self {
        Self {
            client: Client::new(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
            bucket: bucket.to_string(),
            access_key_id: access_key_id.to_string(),
            secret_access_key: secret_access_key.to_string(),
        }
    }

    /// Build the full URL for an object key.
    fn object_url(&self, key: &str) -> String {
        format!("{}/{}/{}", self.endpoint, self.bucket, key)
    }

    /// Upload a file to R2.
    pub async fn put_object(&self, key: &str, body: Vec<u8>) -> Result<(), SyncError> {
        let url = self.object_url(key);
        debug!(key, url, size = body.len(), "R2 PUT");

        let resp = self
            .client
            .put(&url)
            .header("x-amz-date", Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .header("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
            .basic_auth(&self.access_key_id, Some(&self.secret_access_key))
            .body(body)
            .send()
            .await
            .map_err(|e| SyncError::R2(format!("PUT {key}: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::R2(format!("PUT {key}: HTTP {status} — {body}")));
        }
        Ok(())
    }

    /// Upload a local file to R2.
    pub async fn upload_file(&self, key: &str, local_path: &Path) -> Result<(), SyncError> {
        let body = fs::read(local_path)
            .await
            .map_err(|e| SyncError::Io(format!("read {}: {e}", local_path.display())))?;
        self.put_object(key, body).await
    }

    /// Download an object from R2 and return its bytes.
    pub async fn get_object(&self, key: &str) -> Result<Vec<u8>, SyncError> {
        let url = self.object_url(key);
        debug!(key, url, "R2 GET");

        let resp = self
            .client
            .get(&url)
            .header("x-amz-date", Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .header("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
            .basic_auth(&self.access_key_id, Some(&self.secret_access_key))
            .send()
            .await
            .map_err(|e| SyncError::R2(format!("GET {key}: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::R2(format!("GET {key}: HTTP {status} — {body}")));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| SyncError::R2(format!("GET {key} body: {e}")))
    }

    /// Download an object from R2 to a local file.
    pub async fn download_file(&self, key: &str, local_path: &Path) -> Result<(), SyncError> {
        let bytes = self.get_object(key).await?;
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| SyncError::Io(format!("mkdir {}: {e}", parent.display())))?;
        }
        fs::write(local_path, &bytes)
            .await
            .map_err(|e| SyncError::Io(format!("write {}: {e}", local_path.display())))?;
        Ok(())
    }

    /// Check if R2 is reachable by issuing a HEAD on the bucket.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/{}", self.endpoint, self.bucket);
        match self.client
            .head(&url)
            .basic_auth(&self.access_key_id, Some(&self.secret_access_key))
            .send()
            .await
        {
            Ok(resp) => {
                let ok = resp.status().is_success() || resp.status().as_u16() == 404;
                if !ok {
                    warn!(status = %resp.status(), "R2 health check failed");
                }
                ok
            }
            Err(e) => {
                warn!(error = %e, "R2 health check unreachable");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_url_construction() {
        let client = R2Client::new(
            "https://abc.r2.cloudflarestorage.com",
            "gctl-sync",
            "key",
            "secret",
        );
        assert_eq!(
            client.object_url("ws1/dev1/sessions/2026-04-06/p1.parquet"),
            "https://abc.r2.cloudflarestorage.com/gctl-sync/ws1/dev1/sessions/2026-04-06/p1.parquet"
        );
    }

    #[test]
    fn object_url_strips_trailing_slash() {
        let client = R2Client::new(
            "https://abc.r2.cloudflarestorage.com/",
            "gctl-sync",
            "key",
            "secret",
        );
        assert_eq!(
            client.object_url("test.parquet"),
            "https://abc.r2.cloudflarestorage.com/gctl-sync/test.parquet"
        );
    }
}
