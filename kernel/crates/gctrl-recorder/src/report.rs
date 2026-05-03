//! `ObservabilityReport` — a single JSON blob the test harness can fetch
//! with one request after a scenario completes. Mirrors the shape that
//! `apps/gctrl-board/tests/acceptance/fixtures/cdp.ts::CDPObserver.report`
//! returns today.

use serde::{Deserialize, Serialize};

use crate::structured::{CapturedRequest, ConsoleEntry, MetricSample};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityReport {
    pub session_id: String,
    pub requests: Vec<CapturedRequest>,
    pub console: Vec<ConsoleEntry>,
    pub metrics: Vec<MetricSample>,
    pub stats: ReportStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStats {
    pub recorded_bytes: u64,
    pub dropped_frames: u64,
    pub request_count: usize,
    pub console_count: usize,
    pub metric_count: usize,
    pub error_console_count: usize,
    pub failed_request_count: usize,
}

impl ObservabilityReport {
    pub fn build(
        session_id: String,
        requests: Vec<CapturedRequest>,
        console: Vec<ConsoleEntry>,
        metrics: Vec<MetricSample>,
        recorded_bytes: u64,
        dropped_frames: u64,
    ) -> Self {
        let error_console_count = console
            .iter()
            .filter(|c| {
                matches!(
                    c.level,
                    crate::structured::ConsoleLevel::Error
                        | crate::structured::ConsoleLevel::Exception
                )
            })
            .count();
        let failed_request_count = requests.iter().filter(|r| r.failed).count();
        let stats = ReportStats {
            recorded_bytes,
            dropped_frames,
            request_count: requests.len(),
            console_count: console.len(),
            metric_count: metrics.len(),
            error_console_count,
            failed_request_count,
        };
        ObservabilityReport {
            session_id,
            requests,
            console,
            metrics,
            stats,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structured::ConsoleLevel;
    use chrono::Utc;

    #[test]
    fn report_summarises_counts() {
        let now = Utc::now();
        let req = CapturedRequest {
            request_id: "r".into(),
            url: "u".into(),
            method: "GET".into(),
            status: Some(500),
            started_at: now,
            finished_at: Some(now),
            failed: true,
        };
        let console = vec![
            ConsoleEntry {
                seq: 0,
                level: ConsoleLevel::Error,
                kind: "error".into(),
                text: "boom".into(),
                ts: now,
            },
            ConsoleEntry {
                seq: 1,
                level: ConsoleLevel::Info,
                kind: "info".into(),
                text: "ok".into(),
                ts: now,
            },
        ];
        let r = ObservabilityReport::build(
            "sess1".into(),
            vec![req],
            console,
            vec![],
            42,
            7,
        );
        assert_eq!(r.stats.recorded_bytes, 42);
        assert_eq!(r.stats.dropped_frames, 7);
        assert_eq!(r.stats.request_count, 1);
        assert_eq!(r.stats.console_count, 2);
        assert_eq!(r.stats.error_console_count, 1);
        assert_eq!(r.stats.failed_request_count, 1);
    }
}
