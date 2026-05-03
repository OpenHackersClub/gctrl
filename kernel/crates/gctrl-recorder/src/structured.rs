//! Structured records derived from CDP frames. Field names mirror the
//! TypeScript shapes in `apps/gctrl-board/tests/acceptance/fixtures/cdp.ts`
//! so the PR5 migration can swap the HTTP fetch in for the in-process
//! call without touching assertion code.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    /// Populated once `Network.responseReceived` arrives. `None` for
    /// in-flight requests at the moment the report is generated.
    pub status: Option<i64>,
    /// Wall-clock timestamp of `Network.requestWillBeSent`.
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// Populated by `Network.loadingFinished` / `loadingFailed`.
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub failed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    Log,
    Info,
    Warn,
    Error,
    Debug,
    Exception,
}

impl ConsoleLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConsoleLevel::Log => "log",
            ConsoleLevel::Info => "info",
            ConsoleLevel::Warn => "warn",
            ConsoleLevel::Error => "error",
            ConsoleLevel::Debug => "debug",
            ConsoleLevel::Exception => "exception",
        }
    }

    /// Map a CDP `Runtime.consoleAPICalled` `type` field to a level.
    pub fn from_console_type(t: &str) -> Self {
        match t {
            "warning" | "warn" => ConsoleLevel::Warn,
            "error" => ConsoleLevel::Error,
            "info" => ConsoleLevel::Info,
            "debug" | "trace" => ConsoleLevel::Debug,
            _ => ConsoleLevel::Log,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub seq: u64,
    pub level: ConsoleLevel,
    /// Original CDP type/source (`consoleAPICalled.type`, `Log.entryAdded.source`,
    /// or literal `"exception"`).
    pub kind: String,
    pub text: String,
    pub ts: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricSample {
    pub name: String,
    pub value: f64,
    pub ts: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_level_maps_known_types() {
        assert_eq!(ConsoleLevel::from_console_type("warning"), ConsoleLevel::Warn);
        assert_eq!(ConsoleLevel::from_console_type("error"), ConsoleLevel::Error);
        assert_eq!(ConsoleLevel::from_console_type("info"), ConsoleLevel::Info);
        assert_eq!(ConsoleLevel::from_console_type("trace"), ConsoleLevel::Debug);
        assert_eq!(ConsoleLevel::from_console_type("anything-else"), ConsoleLevel::Log);
    }
}
