//! Capture sink — subscribes to a per-session CDP frame broadcast and
//! parses incoming JSON into structured records.
//!
//! Holds bounded in-memory state. The route layer (in `gctrl-otel`)
//! periodically flushes the structured records into DuckDB; this crate
//! does **not** depend on `gctrl-storage` so it stays unit-testable.

use std::collections::HashMap;

use gctrl_browser::{cdp_proxy::FrameDirection, CdpFrame};
use serde_json::Value;
use tokio::sync::{broadcast, RwLock};
use tracing::warn;

use crate::structured::{CapturedRequest, ConsoleEntry, ConsoleLevel, MetricSample};

/// Bounded in-memory buffer per session. Caller (recorder routes) reads
/// snapshots; capture loop writes.
#[derive(Debug, Default)]
struct State {
    requests: HashMap<String, CapturedRequest>,
    console: Vec<ConsoleEntry>,
    metrics: Vec<MetricSample>,
    next_seq: u64,
    /// Frames recorder dropped because the broadcast channel was full
    /// (recorder lagged behind the proxy).
    dropped_frames: u64,
    recorded_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct CaptureStats {
    pub requests: usize,
    pub console_entries: usize,
    pub metrics: usize,
    pub dropped_frames: u64,
    pub recorded_bytes: u64,
}

pub struct CaptureSink {
    state: RwLock<State>,
    /// Hard cap on bytes the recorder will retain in memory. When
    /// reached, structured tables stop accepting new rows; the dropped
    /// counter is incremented and surfaced via `stats()`.
    max_bytes: u64,
}

impl CaptureSink {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            state: RwLock::new(State::default()),
            max_bytes,
        }
    }

    /// Spawn a tokio task that pumps a single session's frame stream into
    /// this sink. Returns the join handle so callers (route layer) can
    /// abort it on session release.
    pub fn pump(
        sink: std::sync::Arc<Self>,
        mut rx: broadcast::Receiver<CdpFrame>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(frame) => sink.ingest(&frame).await,
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        let mut st = sink.state.write().await;
                        st.dropped_frames += n;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        })
    }

    /// Synchronous ingest path — used by tests to drive the sink without
    /// a real broadcast channel. The pump task calls this for every frame.
    pub async fn ingest(&self, frame: &CdpFrame) {
        let mut st = self.state.write().await;
        if st.recorded_bytes >= self.max_bytes {
            st.dropped_frames += 1;
            return;
        }
        st.recorded_bytes += frame.payload.len() as u64;

        // Only browser→client events carry observable state; client→browser
        // are commands, useful for full mode (recorder_cdp_events) but not
        // for structured tables.
        if frame.direction != FrameDirection::BrowserToClient {
            return;
        }

        let v: Value = match serde_json::from_str(&frame.payload) {
            Ok(v) => v,
            Err(e) => {
                warn!(error=%e, "recorder: dropping non-json frame");
                return;
            }
        };
        let method = match v.get("method").and_then(|m| m.as_str()) {
            Some(m) => m,
            None => return, // command response, not an event
        };
        let params = v.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "Network.requestWillBeSent" => {
                if let (Some(rid), Some(req)) = (
                    params.get("requestId").and_then(|v| v.as_str()),
                    params.get("request"),
                ) {
                    let url = req.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let m = req.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string();
                    st.requests.insert(
                        rid.to_string(),
                        CapturedRequest {
                            request_id: rid.to_string(),
                            url,
                            method: m,
                            status: None,
                            started_at: frame.ts,
                            finished_at: None,
                            failed: false,
                        },
                    );
                }
            }
            "Network.responseReceived" => {
                if let (Some(rid), Some(resp)) = (
                    params.get("requestId").and_then(|v| v.as_str()),
                    params.get("response"),
                ) {
                    if let Some(req) = st.requests.get_mut(rid) {
                        req.status = resp.get("status").and_then(|v| v.as_i64());
                    }
                }
            }
            "Network.loadingFinished" => {
                if let Some(rid) = params.get("requestId").and_then(|v| v.as_str()) {
                    if let Some(req) = st.requests.get_mut(rid) {
                        req.finished_at = Some(frame.ts);
                    }
                }
            }
            "Network.loadingFailed" => {
                if let Some(rid) = params.get("requestId").and_then(|v| v.as_str()) {
                    if let Some(req) = st.requests.get_mut(rid) {
                        req.finished_at = Some(frame.ts);
                        req.failed = true;
                    }
                }
            }
            "Runtime.consoleAPICalled" => {
                let kind = params
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("log")
                    .to_string();
                let level = ConsoleLevel::from_console_type(&kind);
                let text = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|args| {
                        args.iter()
                            .filter_map(|a| {
                                a.get("value")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        a.get("description")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string())
                                    })
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                let seq = st.next_seq;
                st.next_seq += 1;
                st.console.push(ConsoleEntry {
                    seq,
                    level,
                    kind,
                    text,
                    ts: frame.ts,
                });
            }
            "Runtime.exceptionThrown" => {
                let text = params
                    .get("exceptionDetails")
                    .and_then(|d| d.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("uncaught exception")
                    .to_string();
                let seq = st.next_seq;
                st.next_seq += 1;
                st.console.push(ConsoleEntry {
                    seq,
                    level: ConsoleLevel::Exception,
                    kind: "exception".into(),
                    text,
                    ts: frame.ts,
                });
            }
            "Log.entryAdded" => {
                if let Some(entry) = params.get("entry") {
                    let level_str =
                        entry.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                    let level = match level_str {
                        "error" => ConsoleLevel::Error,
                        "warning" => ConsoleLevel::Warn,
                        "info" => ConsoleLevel::Info,
                        _ => ConsoleLevel::Log,
                    };
                    let text =
                        entry.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let kind =
                        entry.get("source").and_then(|v| v.as_str()).unwrap_or("log").to_string();
                    let seq = st.next_seq;
                    st.next_seq += 1;
                    st.console.push(ConsoleEntry {
                        seq,
                        level,
                        kind,
                        text,
                        ts: frame.ts,
                    });
                }
            }
            "Performance.metrics" => {
                if let Some(metrics) = params.get("metrics").and_then(|v| v.as_array()) {
                    for m in metrics {
                        if let (Some(name), Some(value)) = (
                            m.get("name").and_then(|v| v.as_str()),
                            m.get("value").and_then(|v| v.as_f64()),
                        ) {
                            st.metrics.push(MetricSample {
                                name: name.to_string(),
                                value,
                                ts: frame.ts,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub async fn requests(&self) -> Vec<CapturedRequest> {
        self.state.read().await.requests.values().cloned().collect()
    }

    pub async fn console(&self) -> Vec<ConsoleEntry> {
        self.state.read().await.console.clone()
    }

    pub async fn metrics(&self) -> Vec<MetricSample> {
        self.state.read().await.metrics.clone()
    }

    pub async fn stats(&self) -> CaptureStats {
        let st = self.state.read().await;
        CaptureStats {
            requests: st.requests.len(),
            console_entries: st.console.len(),
            metrics: st.metrics.len(),
            dropped_frames: st.dropped_frames,
            recorded_bytes: st.recorded_bytes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctrl_browser::cdp_proxy::FrameDirection;

    fn frame(payload: &str) -> CdpFrame {
        CdpFrame {
            direction: FrameDirection::BrowserToClient,
            payload: payload.into(),
            ts: Utc::now(),
        }
    }

    #[tokio::test]
    async fn captures_request_lifecycle() {
        let sink = CaptureSink::new(1024 * 1024);
        sink.ingest(&frame(
            r#"{"method":"Network.requestWillBeSent","params":{"requestId":"r1","request":{"url":"https://example.com/x","method":"GET"}}}"#,
        ))
        .await;
        sink.ingest(&frame(
            r#"{"method":"Network.responseReceived","params":{"requestId":"r1","response":{"status":200}}}"#,
        ))
        .await;
        sink.ingest(&frame(
            r#"{"method":"Network.loadingFinished","params":{"requestId":"r1"}}"#,
        ))
        .await;
        let reqs = sink.requests().await;
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].url, "https://example.com/x");
        assert_eq!(reqs[0].status, Some(200));
        assert!(reqs[0].finished_at.is_some());
        assert!(!reqs[0].failed);
    }

    #[tokio::test]
    async fn captures_failed_request() {
        let sink = CaptureSink::new(1024 * 1024);
        sink.ingest(&frame(
            r#"{"method":"Network.requestWillBeSent","params":{"requestId":"r2","request":{"url":"https://example.com","method":"GET"}}}"#,
        ))
        .await;
        sink.ingest(&frame(
            r#"{"method":"Network.loadingFailed","params":{"requestId":"r2"}}"#,
        ))
        .await;
        let reqs = sink.requests().await;
        assert!(reqs[0].failed);
    }

    #[tokio::test]
    async fn captures_console_entries() {
        let sink = CaptureSink::new(1024 * 1024);
        sink.ingest(&frame(
            r#"{"method":"Runtime.consoleAPICalled","params":{"type":"warning","args":[{"value":"low memory"}]}}"#,
        ))
        .await;
        sink.ingest(&frame(
            r#"{"method":"Runtime.exceptionThrown","params":{"exceptionDetails":{"text":"boom"}}}"#,
        ))
        .await;
        let log = sink.console().await;
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].level, ConsoleLevel::Warn);
        assert_eq!(log[0].text, "low memory");
        assert_eq!(log[1].level, ConsoleLevel::Exception);
    }

    #[tokio::test]
    async fn captures_performance_metrics() {
        let sink = CaptureSink::new(1024 * 1024);
        sink.ingest(&frame(
            r#"{"method":"Performance.metrics","params":{"metrics":[{"name":"JSHeapUsedSize","value":12345.0}]}}"#,
        ))
        .await;
        let m = sink.metrics().await;
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "JSHeapUsedSize");
        assert_eq!(m[0].value, 12345.0);
    }

    #[tokio::test]
    async fn ignores_client_to_browser_frames() {
        let sink = CaptureSink::new(1024 * 1024);
        sink.ingest(&CdpFrame {
            direction: FrameDirection::ClientToBrowser,
            payload: r#"{"id":1,"method":"Network.enable"}"#.into(),
            ts: Utc::now(),
        })
        .await;
        let stats = sink.stats().await;
        // bytes counted, but no structured rows produced for the command.
        assert!(stats.recorded_bytes > 0);
        assert_eq!(stats.requests, 0);
    }

    #[tokio::test]
    async fn ignores_command_responses() {
        let sink = CaptureSink::new(1024 * 1024);
        // Browser → client but no `method` field == response to a command.
        sink.ingest(&frame(r#"{"id":1,"result":{}}"#)).await;
        assert!(sink.requests().await.is_empty());
        assert!(sink.console().await.is_empty());
    }

    #[tokio::test]
    async fn cap_drops_frames_after_max_bytes() {
        let sink = CaptureSink::new(50);
        for i in 0..10 {
            sink.ingest(&frame(&format!(
                r#"{{"method":"Network.requestWillBeSent","params":{{"requestId":"r{i}","request":{{"url":"u","method":"GET"}}}}}}"#,
            )))
            .await;
        }
        let stats = sink.stats().await;
        assert!(stats.dropped_frames > 0);
    }
}
