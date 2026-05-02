use std::sync::Arc;

use chrono::Utc;
use tokio::sync::RwLock;

use crate::{
    config::BrowserConfig,
    error::BrowserError,
    model::{SessionId, SessionInfo, SessionOptions, SessionStatus},
    token::mint_token,
};

/// Pool of long-lived Chromium processes hosting per-session
/// `BrowserContext`s. PR1 is a placeholder: state shape and public API are
/// final, but `acquire` does not actually launch Chromium — it returns
/// `BrowserError::Launch("not implemented in PR1 — pool stub")`. PR2 wires
/// the `chromiumoxide` integration behind this same interface.
pub struct Pool {
    config: Arc<BrowserConfig>,
    /// In PR1 always empty. PR2 will populate it via `acquire`.
    sessions: RwLock<Vec<SessionInfo>>,
}

impl Pool {
    pub fn new(config: Arc<BrowserConfig>) -> Self {
        Pool {
            config,
            sessions: RwLock::new(Vec::new()),
        }
    }

    pub fn config(&self) -> &BrowserConfig {
        &self.config
    }

    /// Best-effort active session count; useful for `/api/browser/health`.
    pub async fn active_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    /// Acquire a new session.
    ///
    /// PR1: validates options against config, returns `BrowserError::Launch`
    /// without spawning Chromium. PR2: spawns/reuses a pooled Chromium,
    /// creates a `BrowserContext`, mints a token, and returns the
    /// populated `SessionInfo`.
    pub async fn acquire(
        &self,
        opts: SessionOptions,
    ) -> Result<SessionInfo, BrowserError> {
        // Validate the request against config bounds — these checks belong
        // here (not in the route layer) so callers from inside the kernel
        // get the same gates as HTTP callers.
        if opts.headed && !self.config.headed_default {
            return Err(BrowserError::InvalidRequest(
                "headed mode requires browser.headed_default=true and a display server".into(),
            ));
        }
        if opts.ttl_seconds == 0 || opts.ttl_seconds > 3600 {
            return Err(BrowserError::InvalidRequest(
                "ttl_seconds must be in (0, 3600]".into(),
            ));
        }
        if opts.recording.max_bytes == 0 {
            return Err(BrowserError::InvalidRequest(
                "recording.max_bytes must be > 0".into(),
            ));
        }

        // Pool capacity check. Real implementation will consider per-Chromium
        // contexts_per_chromium_max as well; stub uses pool_max as a flat cap.
        let active = self.active_count().await as u32;
        if active >= self.config.pool_max {
            return Err(BrowserError::PoolExhausted {
                max: self.config.pool_max,
            });
        }

        Err(BrowserError::Launch(
            "not implemented in PR1 — pool stub; chromium launch lands in PR2".into(),
        ))
    }

    /// Release a session immediately. PR1: 404s for any id since acquire
    /// never populates the pool.
    pub async fn release(&self, id: &SessionId) -> Result<(), BrowserError> {
        let mut sessions = self.sessions.write().await;
        let before = sessions.len();
        sessions.retain(|s| &s.id != id);
        if sessions.len() == before {
            Err(BrowserError::SessionNotFound(id.clone()))
        } else {
            Ok(())
        }
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.sessions.read().await.clone()
    }

    pub async fn get(&self, id: &SessionId) -> Option<SessionInfo> {
        self.sessions
            .read()
            .await
            .iter()
            .find(|s| &s.id == id)
            .cloned()
    }
}

/// Build a `SessionInfo` skeleton for a given options + cdp_endpoint base.
/// Exposed for PR2's pool implementation to share with PR1's tests.
pub fn build_info(
    id: SessionId,
    opts: &SessionOptions,
    browser_version: String,
    cdp_endpoint: String,
) -> SessionInfo {
    let token = mint_token();
    let now = Utc::now();
    SessionInfo {
        id,
        created_at: now,
        expires_at: now + chrono::Duration::seconds(opts.ttl_seconds as i64),
        browser_version,
        status: SessionStatus::Active,
        recording: opts.recording.clone(),
        cdp_endpoint,
        token: token.0,
        dropped_frames: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Arc<BrowserConfig> {
        Arc::new(BrowserConfig::default())
    }

    #[tokio::test]
    async fn acquire_returns_launch_until_pr2() {
        let pool = Pool::new(cfg());
        let err = pool.acquire(SessionOptions::default()).await.unwrap_err();
        assert!(matches!(err, BrowserError::Launch(_)));
        assert_eq!(err.kind(), "launch_failed");
    }

    #[tokio::test]
    async fn acquire_rejects_zero_ttl() {
        let pool = Pool::new(cfg());
        let opts = SessionOptions {
            ttl_seconds: 0,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn acquire_rejects_oversized_ttl() {
        let pool = Pool::new(cfg());
        let opts = SessionOptions {
            ttl_seconds: 4000,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn acquire_rejects_headed_when_disabled() {
        let pool = Pool::new(cfg());
        let opts = SessionOptions {
            headed: true,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn release_unknown_404s() {
        let pool = Pool::new(cfg());
        let err = pool.release(&SessionId::new()).await.unwrap_err();
        assert_eq!(err.kind(), "session_not_found");
    }

    #[tokio::test]
    async fn list_empty_in_pr1() {
        let pool = Pool::new(cfg());
        assert!(pool.list().await.is_empty());
        assert_eq!(pool.active_count().await, 0);
    }

    #[test]
    fn build_info_populates_token_and_expiry() {
        let opts = SessionOptions::default();
        let id = SessionId::new();
        let info = build_info(
            id.clone(),
            &opts,
            "Chromium/stub".into(),
            format!("ws://127.0.0.1:4318/api/browser/sessions/{id}/cdp?token=stub"),
        );
        assert_eq!(info.id, id);
        assert!(!info.token.is_empty());
        assert!(info.expires_at > info.created_at);
        assert_eq!(info.status, SessionStatus::Active);
    }
}
