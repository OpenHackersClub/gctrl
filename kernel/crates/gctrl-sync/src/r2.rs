//! R2 client — S3-compatible upload/download to Cloudflare R2.
//!
//! Uses reqwest with proper AWS Signature V4 (AWS4-HMAC-SHA256) signing.
//! Cloudflare R2 strictly requires sigv4 — earlier `basic_auth + x-amz-*`
//! header form returns `400 InvalidRequest "Please use AWS4-HMAC-SHA256"`.
//!
//! R2 supports the S3 PutObject/GetObject/ListObjectsV2 API subset.

use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::fs;
use tracing::{debug, warn};

use crate::SyncError;

type HmacSha256 = Hmac<Sha256>;

/// R2 region tag — Cloudflare uses literal "auto" for sigv4 scope.
const R2_REGION: &str = "auto";
const R2_SERVICE: &str = "s3";

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

        let body_sha = sha256_hex(&body);
        let auth = self.signed_headers("PUT", &url, &body_sha)?;

        let resp = self
            .client
            .put(&url)
            .header("host", auth.host)
            .header("x-amz-date", auth.amz_date)
            .header("x-amz-content-sha256", body_sha)
            .header("authorization", auth.authorization)
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

        let body_sha = sha256_hex(&[]);
        let auth = self.signed_headers("GET", &url, &body_sha)?;

        let resp = self
            .client
            .get(&url)
            .header("host", auth.host)
            .header("x-amz-date", auth.amz_date)
            .header("x-amz-content-sha256", body_sha)
            .header("authorization", auth.authorization)
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
        let body_sha = sha256_hex(&[]);
        let auth = match self.signed_headers("HEAD", &url, &body_sha) {
            Ok(a) => a,
            Err(e) => {
                warn!(error = %e, "R2 health check sign failed");
                return false;
            }
        };
        match self
            .client
            .head(&url)
            .header("host", auth.host)
            .header("x-amz-date", auth.amz_date)
            .header("x-amz-content-sha256", body_sha)
            .header("authorization", auth.authorization)
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

    /// Build sigv4 signed headers for a request. Signs `host`, `x-amz-date`,
    /// `x-amz-content-sha256`. R2 region is `auto`, service is `s3`.
    fn signed_headers(
        &self,
        method: &str,
        url_str: &str,
        payload_sha_hex: &str,
    ) -> Result<SignedHeaders, SyncError> {
        let url: Url = url_str
            .parse()
            .map_err(|e| SyncError::R2(format!("parse url {url_str}: {e}")))?;
        let host = url
            .host_str()
            .ok_or_else(|| SyncError::R2(format!("no host in url {url_str}")))?
            .to_string();
        let path = url.path();
        let canonical_path = aws_uri_encode_path(path);

        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let scope = format!("{date_stamp}/{R2_REGION}/{R2_SERVICE}/aws4_request");

        // Canonical request — headers must be sorted lowercase, trimmed, no dup whitespace.
        let canonical_headers = format!(
            "host:{host}\nx-amz-content-sha256:{payload_sha_hex}\nx-amz-date:{amz_date}\n"
        );
        let signed_header_names = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_path}\n\n{canonical_headers}\n{signed_header_names}\n{payload_sha_hex}"
        );

        // String to sign.
        let cr_hash = sha256_hex(canonical_request.as_bytes());
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{cr_hash}");

        // Derived signing key: HMAC chain date → region → service → "aws4_request".
        let k_date = hmac_sha256(
            format!("AWS4{}", self.secret_access_key).as_bytes(),
            date_stamp.as_bytes(),
        )?;
        let k_region = hmac_sha256(&k_date, R2_REGION.as_bytes())?;
        let k_service = hmac_sha256(&k_region, R2_SERVICE.as_bytes())?;
        let k_signing = hmac_sha256(&k_service, b"aws4_request")?;

        // Signature.
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes())?);

        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_header_names}, Signature={signature}",
            self.access_key_id
        );

        Ok(SignedHeaders {
            host,
            amz_date,
            authorization,
        })
    }
}

struct SignedHeaders {
    host: String,
    amz_date: String,
    authorization: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, SyncError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| SyncError::R2(format!("hmac key: {e}")))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// AWS canonical URI encoding for the path. Each path segment is URL-encoded
/// (RFC 3986 unreserved set kept verbatim, everything else percent-encoded),
/// but `/` between segments is preserved.
fn aws_uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for (i, seg) in path.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        for b in seg.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char);
                }
                _ => {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_url_construction() {
        let client = R2Client::new(
            "https://abc.r2.cloudflarestorage.com",
            "gctrl-sync",
            "key",
            "secret",
        );
        assert_eq!(
            client.object_url("ws1/dev1/sessions/2026-04-06/p1.parquet"),
            "https://abc.r2.cloudflarestorage.com/gctrl-sync/ws1/dev1/sessions/2026-04-06/p1.parquet"
        );
    }

    #[test]
    fn object_url_strips_trailing_slash() {
        let client = R2Client::new(
            "https://abc.r2.cloudflarestorage.com/",
            "gctrl-sync",
            "key",
            "secret",
        );
        assert_eq!(
            client.object_url("test.parquet"),
            "https://abc.r2.cloudflarestorage.com/gctrl-sync/test.parquet"
        );
    }

    #[test]
    fn aws_uri_encode_keeps_slashes_encodes_spaces() {
        assert_eq!(
            aws_uri_encode_path("/foo/bar baz/2026-W19.md"),
            "/foo/bar%20baz/2026-W19.md"
        );
    }

    #[test]
    fn signed_headers_have_aws4_prefix() {
        let client = R2Client::new(
            "https://abc.r2.cloudflarestorage.com",
            "gctrl-vault",
            "AKIATEST",
            "secret-key-test",
        );
        let h = client
            .signed_headers("PUT", "https://abc.r2.cloudflarestorage.com/gctrl-vault/x.md", &sha256_hex(b"hi"))
            .expect("sign");
        assert!(h.authorization.starts_with("AWS4-HMAC-SHA256 "));
        assert!(h.authorization.contains("Credential=AKIATEST/"));
        assert!(h.authorization.contains("/auto/s3/aws4_request"));
        assert!(h.authorization.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
        assert!(h.host == "abc.r2.cloudflarestorage.com");
    }
}
