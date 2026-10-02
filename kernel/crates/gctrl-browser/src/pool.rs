//! Pool of warm Chromium processes hosting per-session `BrowserContext`s.
//!
//! The pool is **launcher-agnostic** — `RealLauncher` spawns Chromium,
//! `MockLauncher` returns a fixed WS URL for tests. New sessions land on
//! the warmest non-saturated, non-draining Chromium; a new Chromium is
//! spun up only if all are saturated and `pool_max` allows.

use std::sync::Arc;

use crate::scope::ContextScope;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use tokio::sync::{broadcast, watch, RwLock};
use tracing::{info, warn};

use crate::cdp_proxy::{CdpFrame, FRAME_TAP_CAPACITY};
use crate::config::BrowserConfig;
use crate::error::BrowserError;
use crate::launcher::{LaunchedChromium, Launcher};
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
}

struct SessionRecord {
    info: SessionInfo,
    token: Token,
    chromium_id: String,
    scope: ContextScope,
    revoke: watch::Sender<bool>,
    /// Only this identity's validated frames are observable on this channel.
    tap: broadcast::Sender<CdpFrame>,
}

impl SessionRecord {
    fn snapshot(&self) -> SessionInfo {
        let mut info = self.info.clone();
        if info.status == SessionStatus::Active
            && (!self.scope.alive.load(std::sync::atomic::Ordering::SeqCst)
                || Utc::now() >= info.expires_at)
        {
            info.status = SessionStatus::Expired;
        }
        info
    }
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
        self.acquire_with_endpoint(opts, &self.cdp_endpoint_base)
            .await
    }

    /// Acquire an identity using the serving kernel's public WebSocket base.
    /// The route validates HTTP authority before supplying this value.
    pub async fn acquire_with_endpoint(
        &self,
        opts: SessionOptions,
        endpoint_base: &str,
    ) -> Result<SessionInfo, BrowserError> {
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
                let launched = self.launcher.launch().await?;
                let now = Utc::now();
                let new_chromium = Chromium {
                    chromium: launched,
                    state: ChromiumState::Active,
                    created_at: now,
                    last_active_at: now,
                    sessions: Vec::new(),
                };
                let id = new_chromium.chromium.id.clone();
                state.chromiums.push(new_chromium);
                id
            }
        };

        let id = SessionId::new();
        let token = mint_token();
        let now = Utc::now();
        let cdp_endpoint = format!(
            "{}/api/browser/sessions/{}/cdp?token={}",
            endpoint_base, id, token.0
        );

        let chromium = state
            .chromiums
            .iter_mut()
            .find(|c| c.chromium.id == chromium_id)
            .expect("chromium id resolved above");

        // Serialize context allocation with slot reservation: a concurrent
        // acquire cannot bypass pool limits while a new process is launching.
        let browser_context_id = match self.launcher.create_context(&chromium.chromium).await {
            Ok(context) => context,
            Err(error) => {
                // A lost response cannot establish that allocation did not occur.
                // Preserve this process reservation and stop assigning contexts;
                // recycle only after known peers release and exit is confirmed.
                chromium.state = ChromiumState::Draining;
                return Err(error);
            }
        };
        let scope = ContextScope::new(browser_context_id.clone());
        let revoke = scope.revoke.clone();
        let (tap, _) = broadcast::channel::<CdpFrame>(FRAME_TAP_CAPACITY);
        let info = SessionInfo {
            id: id.clone(),
            created_at: now,
            expires_at: now + ChronoDuration::seconds(opts.ttl_seconds as i64),
            browser_version: chromium.chromium.version.clone(),
            browser_context_id,
            status: SessionStatus::Active,
            recording: opts.recording.clone(),
            cdp_endpoint,
            token: token.0.clone(),
            dropped_frames: 0,
        };

        chromium.sessions.push(id.clone());
        chromium.last_active_at = now;

        state.sessions.push(SessionRecord {
            info: info.clone(),
            token,
            chromium_id,
            scope,
            revoke,
            tap,
        });
        Ok(info)
    }

    pub async fn release(&self, id: &SessionId) -> Result<(), BrowserError> {
        let (endpoint, context, alive) = {
            let mut state = self.state.write().await;
            let session = state
                .sessions
                .iter_mut()
                .find(|s| &s.info.id == id)
                .ok_or_else(|| BrowserError::SessionNotFound(id.clone()))?;
            session.info.status = SessionStatus::Releasing;
            session.revoke.send_replace(true);
            let context = session.scope.context_id.clone();
            let alive = session
                .scope
                .alive
                .load(std::sync::atomic::Ordering::SeqCst);
            let chromium_id = session.chromium_id.clone();
            let chromium = state
                .chromiums
                .iter()
                .find(|c| c.chromium.id == chromium_id)
                .ok_or_else(|| BrowserError::Cdp("session chromium disappeared".into()))?;
            (chromium.chromium.browser_ws_url.clone(), context, alive)
        };
        // If disposal cannot be confirmed, retain Releasing and the occupied
        // slot. Tokens are already revoked; cleanup can be retried safely.
        if alive {
            self.launcher.dispose_context(&endpoint, &context).await?;
        }
        let mut state = self.state.write().await;
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
        Ok(())
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.state
            .read()
            .await
            .sessions
            .iter()
            .map(SessionRecord::snapshot)
            .collect()
    }

    pub async fn get(&self, id: &SessionId) -> Option<SessionInfo> {
        self.state
            .read()
            .await
            .sessions
            .iter()
            .find(|s| &s.info.id == id)
            .map(SessionRecord::snapshot)
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
        if session.info.status != SessionStatus::Active
            || *session.revoke.borrow()
            || !session
                .scope
                .alive
                .load(std::sync::atomic::Ordering::SeqCst)
            || Utc::now() >= session.info.expires_at
        {
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
        Ok((
            chromium.chromium.browser_ws_url.clone(),
            session.tap.clone(),
        ))
    }

    /// Validated CDP attachment, including context scope and revocation.
    pub async fn scoped_attachment(
        &self,
        id: &SessionId,
        token: &str,
    ) -> Result<crate::scope::ScopedAttachment, BrowserError> {
        let (endpoint, tap) = self.attach(id, token).await?;
        let state = self.state.read().await;
        let session = state
            .sessions
            .iter()
            .find(|s| &s.info.id == id)
            .ok_or_else(|| BrowserError::SessionNotFound(id.clone()))?;
        if session.info.status != SessionStatus::Active || *session.revoke.borrow() {
            return Err(BrowserError::SessionExpired(id.clone()));
        }
        Ok(crate::scope::ScopedAttachment {
            endpoint,
            tap,
            scope: session.scope.clone(),
            revoked: session.revoke.subscribe(),
            expires_at: session.info.expires_at,
        })
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

        // Revocation and context disposal share the explicit release path.
        let expired: Vec<SessionId> = self
            .state
            .read()
            .await
            .sessions
            .iter()
            .filter(|s| {
                now >= s.info.expires_at
                    || s.info.status == SessionStatus::Releasing
                    || !s.scope.alive.load(std::sync::atomic::Ordering::SeqCst)
            })
            .map(|s| s.info.id.clone())
            .collect();
        for id in expired {
            match self.release(&id).await {
                Ok(()) => report.expired_sessions += 1,
                Err(e) => warn!(session=%id, error=%e, "context cleanup remains uncertain"),
            }
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
                        // A new session may have been allocated since the snapshot.
                        if !state.chromiums[pos].sessions.is_empty() {
                            continue;
                        }
                        state.chromiums[pos].state = ChromiumState::Draining;
                        match self.launcher.kill(&id).await {
                            Ok(()) => {
                                state.chromiums.remove(pos);
                                info!(chromium=%id, reason=reason.as_str(), "recycled chromium");
                                report.killed += 1;
                            }
                            Err(e) => {
                                warn!(error=%e, chromium=%id, "process exit remains uncertain")
                            }
                        }
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
    #[tokio::test]
    async fn parallel_acquire_respects_limits_and_uses_distinct_contexts() {
        let pool = Arc::new(Pool::new(
            Arc::new(BrowserConfig {
                pool_max: 1,
                contexts_per_chromium_max: 2,
                ..Default::default()
            }),
            Arc::new(MockLauncher::new("ws://mock")),
            "ws://kernel".into(),
        ));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                pool.acquire(SessionOptions::default()).await
            }));
        }
        let mut contexts = std::collections::HashSet::new();
        let mut rejected = 0;
        for h in handles {
            match h.await.unwrap() {
                Ok(s) => {
                    assert!(contexts.insert(s.browser_context_id));
                }
                Err(BrowserError::PoolExhausted { .. }) => rejected += 1,
                Err(e) => panic!("unexpected acquire error: {e}"),
            }
        }
        assert_eq!(contexts.len(), 2);
        assert_eq!(rejected, 6);
        assert_eq!(pool.chromium_count().await, 1);
    }

    #[tokio::test]
    async fn taps_are_per_identity_and_release_revokes_existing_attachments() {
        let pool = pool_with_mock();
        let a = pool.acquire(SessionOptions::default()).await.unwrap();
        let b = pool.acquire(SessionOptions::default()).await.unwrap();
        let mut ra = pool.subscribe(&a.id).await.unwrap();
        let mut rb = pool.subscribe(&b.id).await.unwrap();
        let aa = pool.scoped_attachment(&a.id, &a.token).await.unwrap();
        let bb = pool.scoped_attachment(&b.id, &b.token).await.unwrap();
        aa.tap
            .send(CdpFrame {
                direction: crate::FrameDirection::ClientToBrowser,
                payload: "identity-a".into(),
                ts: Utc::now(),
            })
            .unwrap();
        assert_eq!(ra.try_recv().unwrap().payload, "identity-a");
        assert!(
            rb.try_recv().is_err(),
            "sibling recorder observed a foreign frame"
        );
        pool.release(&a.id).await.unwrap();
        assert!(*aa.revoked.borrow());
        assert!(!*bb.revoked.borrow());
        assert!(pool.scoped_attachment(&a.id, &a.token).await.is_err());
        assert!(pool.scoped_attachment(&b.id, &b.token).await.is_ok());
    }

    struct CleanupFailure {
        fail: std::sync::atomic::AtomicBool,
        disposed: std::sync::atomic::AtomicUsize,
    }
    #[async_trait::async_trait]
    impl Launcher for CleanupFailure {
        async fn kill(&self, _: &str) -> Result<(), BrowserError> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err(BrowserError::Launch("exit confirmation lost".into()))
            } else {
                Ok(())
            }
        }
        async fn launch(&self) -> Result<LaunchedChromium, BrowserError> {
            MockLauncher::new("ws://mock").launch().await
        }
        async fn create_context(&self, c: &LaunchedChromium) -> Result<String, BrowserError> {
            MockLauncher::new("ws://mock").create_context(c).await
        }
        async fn dispose_context(&self, _: &str, _: &str) -> Result<(), BrowserError> {
            self.disposed
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err(BrowserError::Cdp("cleanup connection lost".into()))
            } else {
                Ok(())
            }
        }
    }
    #[tokio::test]
    async fn uncertain_cleanup_fences_connections_and_retains_slot_until_confirmed() {
        use std::sync::atomic::Ordering;
        let launcher = Arc::new(CleanupFailure {
            fail: true.into(),
            disposed: 0.into(),
        });
        let pool = Pool::new(
            Arc::new(BrowserConfig {
                pool_max: 1,
                contexts_per_chromium_max: 1,
                ..Default::default()
            }),
            launcher.clone(),
            "ws://kernel".into(),
        );
        let s = pool.acquire(SessionOptions::default()).await.unwrap();
        let attachment = pool.scoped_attachment(&s.id, &s.token).await.unwrap();
        assert!(pool.release(&s.id).await.is_err());
        assert!(*attachment.revoked.borrow());
        assert_eq!(
            pool.get(&s.id).await.unwrap().status,
            SessionStatus::Releasing
        );
        assert!(matches!(
            pool.acquire(SessionOptions::default()).await,
            Err(BrowserError::PoolExhausted { .. })
        ));
        assert!(pool.scoped_attachment(&s.id, &s.token).await.is_err());
        launcher.fail.store(false, Ordering::SeqCst);
        assert_eq!(pool.sweep().await.expired_sessions, 1);
        assert_eq!(launcher.disposed.load(Ordering::SeqCst), 2);
        assert!(pool.get(&s.id).await.is_none());
        assert!(pool.acquire(SessionOptions::default()).await.is_ok());
    }
    #[tokio::test]
    async fn uncertain_process_exit_retains_capacity_until_confirmed() {
        use std::sync::atomic::Ordering;
        let launcher = Arc::new(CleanupFailure {
            fail: false.into(),
            disposed: 0.into(),
        });
        let pool = Pool::new(
            Arc::new(BrowserConfig {
                pool_max: 1,
                contexts_per_chromium_max: 1,
                recycle_idle_seconds: 0,
                ..Default::default()
            }),
            launcher.clone(),
            "ws://kernel".into(),
        );
        let session = pool.acquire(SessionOptions::default()).await.unwrap();
        pool.release(&session.id).await.unwrap();
        launcher.fail.store(true, Ordering::SeqCst);
        assert_eq!(pool.sweep().await.killed, 0);
        assert_eq!(pool.chromium_count().await, 1);
        assert!(matches!(
            pool.acquire(SessionOptions::default()).await,
            Err(BrowserError::PoolExhausted { .. })
        ));
        launcher.fail.store(false, Ordering::SeqCst);
        assert_eq!(pool.sweep().await.killed, 1);
        assert_eq!(pool.chromium_count().await, 0);
        assert!(pool.acquire(SessionOptions::default()).await.is_ok());
    }

    #[tokio::test]
    async fn acquired_endpoint_is_preserved_for_later_inspection() {
        let pool = pool_with_mock();
        let info = pool
            .acquire_with_endpoint(SessionOptions::default(), "ws://127.0.0.1:19418")
            .await
            .unwrap();
        assert!(info.cdp_endpoint.starts_with("ws://127.0.0.1:19418/"));
        assert_eq!(
            pool.get(&info.id).await.unwrap().cdp_endpoint,
            info.cdp_endpoint
        );
    }
    struct ContextCreationFailure;
    #[async_trait::async_trait]
    impl Launcher for ContextCreationFailure {
        async fn launch(&self) -> Result<LaunchedChromium, BrowserError> {
            MockLauncher::new("ws://mock").launch().await
        }
        async fn create_context(&self, _: &LaunchedChromium) -> Result<String, BrowserError> {
            Err(BrowserError::Cdp(
                "context may have been created before connection loss".into(),
            ))
        }
        async fn dispose_context(&self, _: &str, _: &str) -> Result<(), BrowserError> {
            Ok(())
        }
        async fn kill(&self, _: &str) -> Result<(), BrowserError> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn uncertain_context_allocation_drains_the_process_until_exit_is_confirmed() {
        let pool = Pool::new(
            Arc::new(BrowserConfig {
                pool_max: 1,
                ..Default::default()
            }),
            Arc::new(ContextCreationFailure),
            "ws://kernel".into(),
        );
        assert!(matches!(
            pool.acquire(SessionOptions::default()).await,
            Err(BrowserError::Cdp(_))
        ));
        assert!(matches!(
            pool.acquire(SessionOptions::default()).await,
            Err(BrowserError::PoolExhausted { .. })
        ));
        assert_eq!(pool.chromium_count().await, 1);
        assert_eq!(pool.sweep().await.killed, 1);
        assert_eq!(pool.chromium_count().await, 0);
    }
}
