//! Background fiber that closes out idle `active` sessions.
//!
//! OTLP-ingested sessions are auto-created on the first span and only ever
//! transition to `completed` if a client explicitly calls
//! `POST /api/sessions/{id}/end`. Most external recorders (opencode, the
//! relay, ad-hoc curl traces) never do, so the row would otherwise sit in
//! `active` forever and the analytics dashboard would render every past
//! session as "live".
//!
//! The sweeper ticks on `poll_interval` and asks storage to mark any
//! `status='active'` session whose last activity (latest span `started_at`,
//! or session `started_at` if the row has no spans yet) is older than
//! `idle_threshold` as `completed`. The new `ended_at` is set to that last
//! activity timestamp so the row reflects when the session actually went
//! quiet — not when the sweeper noticed.
//!
//! Any sweep produces `session.ended` lifecycle events on the live event
//! bus so SSE-subscribed dashboards drop the row from their live count
//! without having to refetch.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use gctrl_storage::DuckDbStore;
use tracing::{debug, error, info};

use crate::event_bus::{EventBus, SessionEvent};

/// Default idle threshold — five minutes matches the dashboard's polling
/// cadence and is short enough that abandoned relays don't pollute the
/// "Active" filter, but long enough that a session genuinely waiting for
/// the next user turn doesn't get reaped mid-conversation.
pub const DEFAULT_IDLE_SECS: u64 = 5 * 60;

/// How often we re-check. One minute is small relative to the threshold
/// so worst-case lag (idle → swept) is `idle + poll`.
pub const DEFAULT_POLL_SECS: u64 = 60;

pub struct SessionSweeper {
    store: Arc<DuckDbStore>,
    event_bus: Arc<EventBus>,
    idle_secs: u64,
    poll_secs: u64,
}

impl SessionSweeper {
    pub fn new(store: Arc<DuckDbStore>, event_bus: Arc<EventBus>) -> Self {
        Self {
            store,
            event_bus,
            idle_secs: idle_secs_from_env(),
            poll_secs: DEFAULT_POLL_SECS,
        }
    }

    pub fn with_intervals(mut self, idle_secs: u64, poll_secs: u64) -> Self {
        self.idle_secs = idle_secs;
        self.poll_secs = poll_secs;
        self
    }

    /// Run forever. Cancellation is via dropping the parent runtime.
    pub async fn run_forever(self) {
        info!(
            idle_secs = self.idle_secs,
            poll_secs = self.poll_secs,
            "session sweeper started"
        );
        loop {
            if let Err(e) = self.tick().await {
                error!("session sweeper: tick failed: {e:#}");
            }
            tokio::time::sleep(Duration::from_secs(self.poll_secs)).await;
        }
    }

    /// One pass. Public for tests.
    pub async fn tick(&self) -> anyhow::Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::seconds(self.idle_secs as i64);
        let cutoff_iso = cutoff.to_rfc3339();
        let swept = self
            .store
            .sweep_idle_active_sessions(&cutoff_iso)
            .map_err(|e| anyhow::anyhow!("sweep_idle_active_sessions: {e}"))?;
        if swept.is_empty() {
            debug!("session sweeper: no idle sessions");
            return Ok(0);
        }
        let n = swept.len();
        for (id, ended_at) in swept {
            self.event_bus.publish(SessionEvent::Ended {
                session_id: id.0,
                status: "completed".into(),
                ended_at,
            });
        }
        info!(count = n, "session sweeper: closed idle sessions");
        Ok(n)
    }
}

fn idle_secs_from_env() -> u64 {
    std::env::var("GCTRL_SESSION_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v >= 30)
        .unwrap_or(DEFAULT_IDLE_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use gctrl_core::{
        CreatedBy, DeviceId, Session, SessionId, SessionStatus, Span, SpanId, SpanStatus,
        SpanType, TraceId, WorkspaceId,
    };

    fn store() -> Arc<DuckDbStore> {
        Arc::new(DuckDbStore::open(":memory:").unwrap())
    }

    fn make_session(id: &str, started: chrono::DateTime<Utc>) -> Session {
        Session {
            id: SessionId(id.into()),
            workspace_id: WorkspaceId("ws".into()),
            device_id: DeviceId("dev".into()),
            agent_name: "claude".into(),
            started_at: started,
            ended_at: None,
            status: SessionStatus::Active,
            total_cost_usd: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            created_by: CreatedBy::OtelIngest,
        }
    }

    fn make_span(span_id: &str, session_id: &str, started: chrono::DateTime<Utc>) -> Span {
        Span {
            span_id: SpanId(span_id.into()),
            trace_id: TraceId("trace".into()),
            parent_span_id: None,
            session_id: SessionId(session_id.into()),
            agent_name: "claude".into(),
            operation_name: "llm.call".into(),
            span_type: SpanType::Generation,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            status: SpanStatus::Ok,
            started_at: started,
            duration_ms: 100,
            attributes: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn tick_closes_idle_and_publishes_ended() {
        let store = store();
        let bus = EventBus::new(64, 64);

        let stale_started = Utc::now() - ChronoDuration::minutes(20);
        store.insert_session(&make_session("stale", stale_started)).unwrap();
        store
            .insert_span(&make_span(
                "sp_stale",
                "stale",
                Utc::now() - ChronoDuration::minutes(15),
            ))
            .unwrap();

        let recent_started = Utc::now() - ChronoDuration::minutes(2);
        store.insert_session(&make_session("recent", recent_started)).unwrap();
        store
            .insert_span(&make_span(
                "sp_recent",
                "recent",
                Utc::now() - ChronoDuration::seconds(30),
            ))
            .unwrap();

        let mut rx = bus.subscribe();
        let sweeper = SessionSweeper::new(Arc::clone(&store), Arc::clone(&bus))
            .with_intervals(5 * 60, 60);
        let n = sweeper.tick().await.unwrap();
        assert_eq!(n, 1);

        let (_id, ev) = rx.try_recv().expect("expected one Ended event");
        assert_eq!(ev.event_name(), "session.ended");
        assert_eq!(ev.session_id(), "stale");

        let stale_after = store
            .get_session(&SessionId("stale".into()))
            .unwrap()
            .unwrap();
        assert_eq!(stale_after.status, SessionStatus::Completed);
        assert!(stale_after.ended_at.is_some());

        let recent_after = store
            .get_session(&SessionId("recent".into()))
            .unwrap()
            .unwrap();
        assert_eq!(recent_after.status, SessionStatus::Active);
    }

    #[test]
    fn idle_secs_from_env_clamps_short_values() {
        // Below 30s is rejected (would close mid-turn). Default returns instead.
        std::env::set_var("GCTRL_SESSION_IDLE_SECS", "5");
        assert_eq!(idle_secs_from_env(), DEFAULT_IDLE_SECS);
        std::env::set_var("GCTRL_SESSION_IDLE_SECS", "120");
        assert_eq!(idle_secs_from_env(), 120);
        std::env::remove_var("GCTRL_SESSION_IDLE_SECS");
    }
}
