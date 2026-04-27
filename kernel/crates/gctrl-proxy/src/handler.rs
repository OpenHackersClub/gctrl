//! `hudsucker::HttpHandler` that captures each completed request/response
//! pair and writes a `TrafficRecord` row through the kernel's `DuckDbStore`.
//!
//! Headers and bodies are NOT captured — only metadata + sizes. This is
//! intentional: `traffic` rows are queryable by any reader of the kernel
//! API, so logging full bodies would leak request payloads (Authorization
//! headers, OAuth codes, prompt content).

use std::sync::Arc;

use chrono::Utc;
use gctrl_core::TrafficRecord;
use gctrl_storage::DuckDbStore;
use hudsucker::{
    hyper::{Request, Response},
    Body, HttpContext, HttpHandler, RequestOrResponse,
};
use tokio::sync::Mutex;

use crate::redact::redact_url;

/// Per-connection state: hudsucker creates a fresh `HttpHandler` per
/// connection, so the in-flight request fields don't need to be a map.
#[derive(Clone)]
pub struct TrafficLogger {
    store: Arc<DuckDbStore>,
    redact: Arc<Vec<String>>,
    inflight: Arc<Mutex<Option<InflightRequest>>>,
}

#[derive(Clone)]
struct InflightRequest {
    started_at: std::time::Instant,
    timestamp: chrono::DateTime<Utc>,
    method: String,
    url: String,
    host: String,
    request_size: u64,
}

impl TrafficLogger {
    pub fn new(store: Arc<DuckDbStore>, redact: Vec<String>) -> Self {
        Self {
            store,
            redact: Arc::new(redact),
            inflight: Arc::new(Mutex::new(None)),
        }
    }

    fn write_record(&self, record: TrafficRecord) {
        if let Err(e) = self.store.insert_traffic(&record) {
            tracing::warn!(error = %e, "proxy: failed to insert traffic row");
        }
    }
}

impl HttpHandler for TrafficLogger {
    async fn handle_request(
        &mut self,
        _ctx: &HttpContext,
        req: Request<Body>,
    ) -> RequestOrResponse {
        let url = redact_url(&req.uri().to_string(), &self.redact);
        let host = host_from_url(&url);
        let request_size = content_length(req.headers());
        let inflight = InflightRequest {
            started_at: std::time::Instant::now(),
            timestamp: Utc::now(),
            method: req.method().to_string(),
            url,
            host,
            request_size,
        };
        *self.inflight.lock().await = Some(inflight);
        req.into()
    }

    async fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> Response<Body> {
        let response_size = content_length(res.headers());
        let status = res.status().as_u16();

        let inflight = self.inflight.lock().await.take();
        if let Some(req) = inflight {
            let duration_ms = req.started_at.elapsed().as_millis() as u64;
            let record = TrafficRecord {
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: req.timestamp,
                method: req.method,
                url: req.url,
                host: req.host,
                status_code: status,
                request_size_bytes: req.request_size,
                response_size_bytes: response_size,
                duration_ms,
                session_id: None,
            };
            self.write_record(record);
        }
        res
    }
}

fn content_length(headers: &hudsucker::hyper::HeaderMap) -> u64 {
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
}

fn host_from_url(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(h) = parsed.host_str() {
            if !h.is_empty() {
                return h.to_string();
            }
        }
    }
    // Fallback for CONNECT-style "host:port" or scheme-less authorities.
    let head = url.split('/').next().unwrap_or("");
    let host = head.rsplit_once(':').map(|(h, _)| h).unwrap_or(head);
    if host.is_empty() {
        "unknown".to_string()
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_from_full_url() {
        assert_eq!(host_from_url("https://api.example.com/v1/x"), "api.example.com");
    }

    #[test]
    fn host_from_connect_authority() {
        assert_eq!(host_from_url("api.example.com:443"), "api.example.com");
    }

    #[test]
    fn host_unknown_for_garbage() {
        assert_eq!(host_from_url(""), "unknown");
    }

    #[tokio::test]
    async fn write_record_inserts_row() {
        let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let handler = TrafficLogger::new(Arc::clone(&store), vec![]);
        let record = TrafficRecord {
            id: "t1".into(),
            timestamp: Utc::now(),
            method: "GET".into(),
            url: "https://x/y".into(),
            host: "x".into(),
            status_code: 200,
            request_size_bytes: 0,
            response_size_bytes: 42,
            duration_ms: 5,
            session_id: None,
        };
        handler.write_record(record);
        let rows = store
            .query_traffic(&gctrl_core::TrafficFilter::default())
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "x");
    }
}
