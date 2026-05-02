use crate::model::SessionId;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("browser pool exhausted (max={max})")]
    PoolExhausted { max: u32 },

    #[error("session not found: {0}")]
    SessionNotFound(SessionId),

    #[error("session expired: {0}")]
    SessionExpired(SessionId),

    #[error("invalid token for session {0}")]
    InvalidToken(SessionId),

    #[error("recording disabled for this session")]
    RecordingDisabled,

    #[error("chromium launch failed: {0}")]
    Launch(String),

    #[error("cdp protocol error: {0}")]
    Cdp(String),

    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

impl BrowserError {
    /// Stable kind string for logs / OTel attributes / route-layer status mapping.
    pub fn kind(&self) -> &'static str {
        match self {
            BrowserError::PoolExhausted { .. } => "pool_exhausted",
            BrowserError::SessionNotFound(_) => "session_not_found",
            BrowserError::SessionExpired(_) => "session_expired",
            BrowserError::InvalidToken(_) => "invalid_token",
            BrowserError::RecordingDisabled => "recording_disabled",
            BrowserError::Launch(_) => "launch_failed",
            BrowserError::Cdp(_) => "cdp_error",
            BrowserError::InvalidRequest(_) => "invalid_request",
        }
    }
}
