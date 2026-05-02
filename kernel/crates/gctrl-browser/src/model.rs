use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Branded identifier for a kernel-managed browser session. One session ==
/// one Chromium `BrowserContext` (cookies/storage/service-workers isolated
/// from siblings).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new() -> Self {
        SessionId(uuid::Uuid::new_v4().to_string())
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for SessionId {
    fn from(s: String) -> Self {
        SessionId(s)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport {
            width: 1280,
            height: 720,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub network: bool,
    pub console: bool,
    pub performance: bool,
    pub screenshots: bool,
    /// When true, persist every CDP frame (high volume — opt-in for
    /// debugging/replay only). Defaults to false.
    pub full: bool,
    /// Hard cap on persisted recording bytes per session. When exceeded,
    /// structured tables stop accepting new rows; the count of dropped
    /// rows is surfaced on `SessionInfo`.
    pub max_bytes: u64,
}

impl Default for RecordingOptions {
    fn default() -> Self {
        RecordingOptions {
            network: true,
            console: true,
            performance: true,
            screenshots: false,
            full: false,
            max_bytes: 50 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub headed: bool,
    #[serde(default)]
    pub recording: RecordingOptions,
    /// Session lifetime in seconds. Capped to 3600 by the route layer.
    #[serde(default = "SessionOptions::default_ttl")]
    pub ttl_seconds: u32,
}

impl SessionOptions {
    fn default_ttl() -> u32 {
        600
    }
}

impl Default for SessionOptions {
    fn default() -> Self {
        SessionOptions {
            viewport: None,
            headed: false,
            recording: RecordingOptions::default(),
            ttl_seconds: Self::default_ttl(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Releasing,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub browser_version: String,
    pub status: SessionStatus,
    pub recording: RecordingOptions,
    /// `ws://127.0.0.1:<port>/api/browser/sessions/<id>/cdp?token=...`
    pub cdp_endpoint: String,
    /// Bearer token for the CDP attach. Also embedded in `cdp_endpoint` as
    /// `?token=...` for client convenience.
    pub token: String,
    /// Frames dropped because the recorder broadcast channel was full.
    /// Best-effort counter, exposed for observability.
    #[serde(default)]
    pub dropped_frames: u64,
}
