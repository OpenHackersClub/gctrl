//! Pool of warm Chromium processes hosting per-session `BrowserContext`s.
//!
//! The pool is **launcher-agnostic** — `RealLauncher` spawns Chromium,
//! `MockLauncher` returns a fixed WS URL for tests. New sessions land on
//! the warmest non-saturated, non-draining Chromium; a new Chromium is
//! spun up only if all are saturated and `pool_max` allows.

use std::sync::Arc;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use crate::cdp_proxy::{CdpFrame, FRAME_TAP_CAPACITY};
use crate::config::BrowserConfig;
use crate::error::BrowserError;
use crate::launcher::{Launcher, LaunchedChromium};
use crate::model::{SessionId, SessionInfo, SessionOptions, SessionStatus};
use crate::recycle::{
    decide as recycle_decide, ChromiumSnapshot, ChromiumState, RecycleConfig, RecyclePlan,
};
use crate::token::{mint_token, Token};

/// One warm Chromium process tracked by the pool.
struct Chromium {
    chromium: LaunchedChromium,
    state: ChromiumState,
    created_at: DateTime<Utc>,
    last_active_at: DateTime<Utc>,
    /// Session ids currently bound to this chromium.
    sessions: Vec<SessionId>,
    /// Per-process broadcast tap shared by every session on this chromium.
    /// Sessions get their own `Sender` clone so the recorder can subscribe
    /// per-session (filtering on `session_id` happens at the recorder).
    tap: broadcast::Sender<CdpFrame>,
}

struct SessionRecord {
    info: SessionInfo,
    token: Token,
    chromium_id: String,
    /// Per-session tap clone — same channel as the parent chromium, but
    /// makes the recorder API symmetric with "subscribe per session id".
    tap: broadcast::Sender<CdpFrame>,
}

pub struct Pool {
    config: Arc<BrowserConfig>,
    launcher: Arc<dyn Launcher>,
    state: RwLock<PoolState>,
    /// Base URL for `cdp_endpoint` strings handed back to clients. Set by
    /// the route layer at construction; tests use a synthetic value.
    cdp_endpoint_base: String,
}

#[derive(Default)]
struct PoolState {
    chromiums: Vec<Chromium>,
    sessions: Vec<SessionRecord>,
}

impl Pool {
    pub fn new(
        config: Arc<BrowserConfig>,
        launcher: Arc<dyn Launcher>,
        cdp_endpoint_base: String,
    ) -> Self {
        Pool {
            config,
            launcher,
            state: RwLock::new(PoolState::default()),
            cdp_endpoint_base,
        }
    }

    pub fn config(&self) -> &BrowserConfig {
        &self.config
    }

    /// Active session count across all chromiums.
    pub async fn active_count(&self) -> usize {
        self.state.read().await.sessions.len()
    }

    /// Number of warm Chromium processes (any state).
    pub async fn chromium_count(&self) -> usize {
        self.state.read().await.chromiums.len()
    }

    /// Browser version of the first warm Chromium, or `None` if the pool
    /// is empty. Reported on `/api/browser/health`.
    pub async fn browser_version(&self) -> Option<String> {
        self.state
            .read()
            .await
            .chromiums
            .first()
            .map(|c| c.chromium.version.clone())
    }

    pub async fn acquire(&self, opts: SessionOptions) -> Result<SessionInfo, BrowserError> {
        // Validate options up-front — these checks belong here (not in
        // the route layer) so in-kernel callers get the same gates.
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

        // Try to reuse an existing chromium first.
        let mut state = self.state.write().await;
        let chromium_id = match find_warmest(&state.chromiums, &self.config) {
            Some(idx) => state.chromiums[idx].chromium.id.clone(),
            None => {
                if state.chromiums.len() as u32 >= self.config.pool_max {
                    return Err(BrowserError::PoolExhausted {
                        max: self.config.pool_max,
                    });
                }
                drop(state);
                let launched = self.launcher.launch().await?;
                let (tx, _rx) = broadcast::channel::<CdpFrame>(FRAME_TAP_CAPACITY);
                let now = Utc::now();
                let new_chromium = Chromium {
                    chromium: launched,
                    state: ChromiumState::Active,
                    created_at: now,
                    last_active_at: now,
                    sessions: Vec::new(),
                    tap: tx,
                };
                let id = new_chromium.chromium.id.clone();
                self.state.write().await.chromiums.push(new_chromium);
                state = self.state.write().await;
                id
            }
        };

        let id = SessionId::new();
        let token = mint_token();
        let now = Utc::now();
        let cdp_endpoint = format!(
            "{}/api/browser/sessions/{}/cdp?token={}",
            self.cdp_endpoint_base, id, token.0
        );

        let chromium = state
            .chromiums
            .iter_mut()
            .find(|c| c.chromium.id == chromium_id)
            .expect("chromium id resolved above");

        let info = SessionInfo {
            id: id.clone(),
            created_at: now,
            expires_at: now + ChronoDuration::seconds(opts.ttl_seconds as i64),
            browser_version: chromium.chromium.version.clone(),
            status: SessionStatus::Active,
            recording: opts.recording.clone(),
            cdp_endpoint,
            token: token.0.clone(),
            dropped_frames: 0,
        };

        chromium.sessions.push(id.clone());
        chromium.last_active_at = now;
        let tap = chromium.tap.clone();

        state.sessions.push(SessionRecord {
            info: info.clone(),
            token,
            chromium_id,
            tap,
        });
        Ok(info)
    }

    pub async fn release(&self, id: &SessionId) -> Result<(), BrowserError> {
        let mut state = self.state.write().await;
        let pos = state
            .sessions
            .iter()
            .position(|s| &s.info.id == id)
            .ok_or_else(|| BrowserError::SessionNotFound(id.clone()))?;
        let removed = state.sessions.remove(pos);
        if let Some(c) = state
            .chromiums
            .iter_mut()
            .find(|c| c.chromium.id == removed.chromium_id)
        {
            c.sessions.retain(|s| s != id);
            c.last_active_at = Utc::now();
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.state
            .read()
            .await
            .sessions
            .iter()
            .map(|s| s.info.clone())
            .collect()
    }

    pub async fn get(&self, id: &SessionId) -> Option<SessionInfo> {
        self.state
            .read()
            .await
            .sessions
            .iter()
            .find(|s| &s.info.id == id)
            .map(|s| s.info.clone())
    }

    /// Look up a session, verify the supplied bearer token, and return
    /// `(upstream_ws_url, tap)` ready for the proxy to use. Wrong token
    /// → `InvalidToken`, expired → `SessionExpired`, unknown → `SessionNotFound`.
    pub async fn attach(
        &self,
        id: &SessionId,
        supplied_token: &str,
    ) -> Result<(String, broadcast::Sender<CdpFrame>), BrowserError> {
        let state = self.state.read().await;
        let session = state
            .sessions
            .iter()
            .find(|s| &s.info.id == id)
            .ok_or_else(|| BrowserError::SessionNotFound(id.clone()))?;
        if Utc::now() >= session.info.expires_at {
            return Err(BrowserError::SessionExpired(id.clone()));
        }
        if !crate::token::verify(supplied_token, session.token.as_str()) {
            return Err(BrowserError::InvalidToken(id.clone()));
        }
        let chromium = state
            .chromiums
            .iter()
            .find(|c| c.chromium.id == session.chromium_id)
            .ok_or_else(|| {
                BrowserError::Cdp("session refers to a chromium that no longer exists".into())
            })?;
        Ok((chromium.chromium.browser_ws_url.clone(), session.tap.clone()))
    }

    /// Subscribe to the per-session frame tap. Used by the recorder.
    pub async fn subscribe(&self, id: &SessionId) -> Option<broadcast::Receiver<CdpFrame>> {
        let state = self.state.read().await;
        state
            .sessions
            .iter()
            .find(|s| &s.info.id == id)
            .map(|s| s.tap.subscribe())
    }

    /// Sweep expired sessions and apply recycle plan. Called periodically
    /// by the recycle background task; returns counts for observability.
    pub async fn sweep(&self) -> SweepReport {
        let now = Utc::now();
        let mut report = SweepReport::default();

        // Expire sessions past their TTL.
        {
            let mut state = self.state.write().await;
            let expired: Vec<SessionId> = state
                .sessions
                .iter()
                .filter(|s| now >= s.info.expires_at)
                .map(|s| s.info.id.clone())
                .collect();
            for id in &expired {
                if let Some(pos) = state.sessions.iter().position(|s| &s.info.id == id) {
                    let removed = state.sessions.remove(pos);
                    if let Some(c) = state
                        .chromiums
                        .iter_mut()
                        .find(|c| c.chromium.id == removed.chromium_id)
                    {
                        c.sessions.retain(|s| s != id);
                        c.last_active_at = Utc::now();
                    }
                }
            }
            report.expired_sessions = expired.len();
        }

        // Recycle decisions.
        let cfg = RecycleConfig {
            recycle_idle_seconds: self.config.recycle_idle_seconds,
            recycle_max_age_seconds: self.config.recycle_max_age_seconds,
        };
        let snapshots: Vec<ChromiumSnapshot> = {
            let state = self.state.read().await;
            state
                .chromiums
                .iter()
                .map(|c| ChromiumSnapshot {
                    id: c.chromium.id.clone(),
                    state: c.state,
                    created_at: c.created_at,
                    last_active_at: c.last_active_at,
                    active_sessions: c.sessions.len() as u32,
                })
                .collect()
        };
        let plans = recycle_decide(&snapshots, &cfg, now);

        for plan in plans {
            match plan {
                RecyclePlan::Drain { id, .. } => {
                    let mut state = self.state.write().await;
                    if let Some(c) = state.chromiums.iter_mut().find(|c| c.chromium.id == id) {
                        c.state = ChromiumState::Draining;
                        report.drained += 1;
                    }
                }
                RecyclePlan::Kill { id, reason } => {
                    let mut state = self.state.write().await;
                    if let Some(pos) = state.chromiums.iter().position(|c| c.chromium.id == id) {
                        let c = state.chromiums.remove(pos);
                        if let Some(mut child) = c.chromium.child.lock().await.take() {
                            if let Err(e) = child.start_kill() {
                                warn!(error=%e, chromium=%c.chromium.id, "failed to kill chromium");
                            }
                        }
                        info!(
                            chromium = %c.chromium.id,
                            reason = reason.as_str(),
                            "recycled chromium"
                        );
                        report.killed += 1;
                    }
                }
            }
        }
        report
    }
}

#[derive(Debug, Default, Clone)]
pub struct SweepReport {
    pub expired_sessions: usize,
    pub drained: usize,
    pub killed: usize,
}

fn find_warmest(chromiums: &[Chromium], config: &BrowserConfig) -> Option<usize> {
    chromiums
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c.state == ChromiumState::Active
                && (c.sessions.len() as u32) < config.contexts_per_chromium_max
        })
        .max_by_key(|(_, c)| c.sessions.len())
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::MockLauncher;

    fn cfg() -> Arc<BrowserConfig> {
        Arc::new(BrowserConfig::default())
    }

    fn pool_with_mock() -> Pool {
        Pool::new(
            cfg(),
            Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake")),
            "ws://127.0.0.1:4318".into(),
        )
    }

    #[tokio::test]
    async fn acquire_rejects_zero_ttl() {
        let pool = pool_with_mock();
        let opts = SessionOptions {
            ttl_seconds: 0,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn acquire_rejects_oversized_ttl() {
        let pool = pool_with_mock();
        let opts = SessionOptions {
            ttl_seconds: 4000,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn acquire_rejects_headed_when_disabled() {
        let pool = pool_with_mock();
        let opts = SessionOptions {
            headed: true,
            ..Default::default()
        };
        let err = pool.acquire(opts).await.unwrap_err();
        assert_eq!(err.kind(), "invalid_request");
    }

    #[tokio::test]
    async fn acquire_creates_session_with_token_and_endpoint() {
        let pool = pool_with_mock();
        let info = pool.acquire(SessionOptions::default()).await.unwrap();
        assert!(!info.token.is_empty());
        assert!(info.cdp_endpoint.contains("/api/browser/sessions/"));
        assert!(info.cdp_endpoint.contains("token="));
        assert_eq!(info.status, SessionStatus::Active);
        assert_eq!(pool.active_count().await, 1);
        assert_eq!(pool.chromium_count().await, 1);
    }

    #[tokio::test]
    async fn list_and_get_round_trip() {
        let pool = pool_with_mock();
        let a = pool.acquire(SessionOptions::default()).await.unwrap();
        let b = pool.acquire(SessionOptions::default()).await.unwrap();
        let listed = pool.list().await;
        assert_eq!(listed.len(), 2);
        let fetched = pool.get(&a.id).await.unwrap();
        assert_eq!(fetched.id, a.id);
        let _ = b;
    }

    #[tokio::test]
    async fn release_unknown_404s() {
        let pool = pool_with_mock();
        let err = pool.release(&SessionId::new()).await.unwrap_err();
        assert_eq!(err.kind(), "session_not_found");
    }

    #[tokio::test]
    async fn release_drops_session_and_decrements_chromium() {
        let pool = pool_with_mock();
        let info = pool.acquire(SessionOptions::default()).await.unwrap();
        pool.release(&info.id).await.unwrap();
        assert_eq!(pool.active_count().await, 0);
        // chromium stays warm
        assert_eq!(pool.chromium_count().await, 1);
    }

    #[tokio::test]
    async fn attach_validates_token() {
        let pool = pool_with_mock();
        let info = pool.acquire(SessionOptions::default()).await.unwrap();
        let ok = pool.attach(&info.id, &info.token).await;
        assert!(ok.is_ok());
        let bad = pool.attach(&info.id, "wrong-token").await.unwrap_err();
        assert_eq!(bad.kind(), "invalid_token");
        let unknown = pool
            .attach(&SessionId::new(), &info.token)
            .await
            .unwrap_err();
        assert_eq!(unknown.kind(), "session_not_found");
    }

    #[tokio::test]
    async fn second_session_reuses_chromium_until_saturated() {
        let pool = pool_with_mock();
        let a = pool.acquire(SessionOptions::default()).await.unwrap();
        let b = pool.acquire(SessionOptions::default()).await.unwrap();
        assert_eq!(pool.chromium_count().await, 1);
        let _ = (a, b);
    }

    #[tokio::test]
    async fn pool_exhausted_after_pool_max_chromiums() {
        let mut config = BrowserConfig::default();
        config.pool_max = 1;
        config.contexts_per_chromium_max = 1;
        let pool = Pool::new(
            Arc::new(config),
            Arc::new(MockLauncher::new("ws://127.0.0.1:0/fake")),
            "ws://127.0.0.1:4318".into(),
        );
        let _a = pool.acquire(SessionOptions::default()).await.unwrap();
        let err = pool.acquire(SessionOptions::default()).await.unwrap_err();
        assert_eq!(err.kind(), "pool_exhausted");
    }

    #[tokio::test]
    async fn sweep_expires_old_sessions() {
        let pool = pool_with_mock();
        let info = pool
            .acquire(SessionOptions {
                ttl_seconds: 1,
                ..Default::default()
            })
            .await
            .unwrap();
        // Force expiry by reaching into state.
        {
            let mut state = pool.state.write().await;
            for s in state.sessions.iter_mut() {
                s.info.expires_at = Utc::now() - ChronoDuration::seconds(1);
            }
        }
        let report = pool.sweep().await;
        assert_eq!(report.expired_sessions, 1);
        assert!(pool.get(&info.id).await.is_none());
    }
}
