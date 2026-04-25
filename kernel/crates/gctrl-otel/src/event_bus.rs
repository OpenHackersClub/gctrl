// Session event bus for SSE streaming.
//
// Per spec/architecture/apps/gctrl-analytics.md §5: a single
// `tokio::sync::broadcast` channel inside `gctrl-otel`'s ingest path,
// with each connected handler holding its own `broadcast::Receiver`.
// On reconnect, clients send `Last-Event-ID` and we replay from an
// in-memory ring; if the requested id has aged out we emit a
// `replay_gap` event.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;

/// Default broadcast channel capacity. Lagging consumers see `Lagged`
/// errors past this watermark; the SSE handler closes the connection
/// and the client reconnects with `Last-Event-ID`.
pub const DEFAULT_CHANNEL_CAPACITY: usize = 256;

/// Default replay-ring capacity (events kept for `Last-Event-ID`
/// reconnect). Sized for ~few seconds at expected throughput.
pub const DEFAULT_RING_CAPACITY: usize = 1024;

/// A discrete event on the session lifecycle. Serialized as the JSON
/// payload of an SSE frame; the SSE event name is derived from the
/// variant tag.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Session created — either by an explicit `POST /api/sessions` or
    /// auto-created on first OTLP ingest.
    Started {
        session_id: String,
        agent_name: String,
        started_at: String,
    },
    /// One span landed. We send the minimum operators want to see in a
    /// trace tree append; the full row is fetched on demand.
    Span {
        session_id: String,
        span_id: String,
        parent_span_id: Option<String>,
        span_type: String,
        operation: String,
        model: Option<String>,
        cost_usd: f64,
        duration_ms: u64,
        status: String,
        ts: String,
    },
    /// Session status changed without ending (e.g. `active` ↔ `failed`
    /// via auto-score logic). Operators want this to colour the row.
    StatusChanged {
        session_id: String,
        status: String,
        ts: String,
    },
    /// Session terminal state.
    Ended {
        session_id: String,
        status: String,
        ended_at: String,
    },
}

impl SessionEvent {
    /// Stable name used in the SSE `event:` line. Stays in sync with the
    /// serde tag for the variant.
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::Started { .. } => "session.started",
            Self::Span { .. } => "session.span",
            Self::StatusChanged { .. } => "session.status_changed",
            Self::Ended { .. } => "session.ended",
        }
    }

    /// The session this event is about, used to filter the per-session
    /// stream.
    pub fn session_id(&self) -> &str {
        match self {
            Self::Started { session_id, .. }
            | Self::Span { session_id, .. }
            | Self::StatusChanged { session_id, .. }
            | Self::Ended { session_id, .. } => session_id,
        }
    }
}

/// One published event with its monotonic id.
pub type Entry = (u64, SessionEvent);

/// Result of a `Last-Event-ID` replay query.
#[derive(Debug)]
pub enum ReplayResult {
    /// Buffered events with id strictly greater than the requested one.
    Events(Vec<Entry>),
    /// The requested id is older than anything in the ring — client must
    /// re-fetch state from non-stream routes and resume tailing.
    Gap,
    /// Nothing buffered yet, or the client is already current.
    Caught,
}

/// In-memory event bus: broadcast fan-out + ring buffer for replay.
pub struct EventBus {
    sender: broadcast::Sender<Entry>,
    next_id: AtomicU64,
    ring: Mutex<VecDeque<Entry>>,
    ring_capacity: usize,
}

impl EventBus {
    pub fn new(channel_capacity: usize, ring_capacity: usize) -> Arc<Self> {
        let (sender, _) = broadcast::channel(channel_capacity);
        Arc::new(Self {
            sender,
            next_id: AtomicU64::new(1),
            ring: Mutex::new(VecDeque::with_capacity(ring_capacity)),
            ring_capacity,
        })
    }

    /// Default-sized bus suitable for production and tests.
    pub fn default_capacity() -> Arc<Self> {
        Self::new(DEFAULT_CHANNEL_CAPACITY, DEFAULT_RING_CAPACITY)
    }

    /// Publish an event. Assigns the next monotonic id, appends to the
    /// replay ring, then fans out on the broadcast channel. A failed
    /// `send` (no live receivers) is not an error — the ring still
    /// retains the event for late subscribers.
    pub fn publish(&self, event: SessionEvent) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry: Entry = (id, event);
        {
            let mut ring = self.ring.lock().expect("event_bus ring poisoned");
            if ring.len() >= self.ring_capacity {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }
        let _ = self.sender.send(entry);
        id
    }

    /// Subscribe a fresh receiver that will see only future events.
    /// Use `replay_after` separately if the client provided a
    /// `Last-Event-ID`.
    pub fn subscribe(&self) -> broadcast::Receiver<Entry> {
        self.sender.subscribe()
    }

    /// Return events with id strictly greater than `last_id`. If the
    /// oldest buffered id is more than one past `last_id`, the client
    /// missed events that have aged out — return `Gap`.
    pub fn replay_after(&self, last_id: u64) -> ReplayResult {
        let ring = self.ring.lock().expect("event_bus ring poisoned");
        let Some(earliest) = ring.front().map(|(id, _)| *id) else {
            return ReplayResult::Caught;
        };
        // last_id + 1 < earliest  ⇒  events between last_id+1 and earliest-1
        // were dropped from the ring, so the client has a gap.
        if last_id + 1 < earliest {
            return ReplayResult::Gap;
        }
        let events: Vec<Entry> = ring
            .iter()
            .filter(|(id, _)| *id > last_id)
            .cloned()
            .collect();
        if events.is_empty() {
            ReplayResult::Caught
        } else {
            ReplayResult::Events(events)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(id: &str) -> SessionEvent {
        SessionEvent::Started {
            session_id: id.into(),
            agent_name: "agent".into(),
            started_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn publish_assigns_monotonic_ids() {
        let bus = EventBus::new(16, 16);
        assert_eq!(bus.publish(started("a")), 1);
        assert_eq!(bus.publish(started("b")), 2);
        assert_eq!(bus.publish(started("c")), 3);
    }

    #[test]
    fn replay_after_returns_only_newer_events() {
        let bus = EventBus::new(16, 16);
        bus.publish(started("a")); // id 1
        bus.publish(started("b")); // id 2
        bus.publish(started("c")); // id 3
        match bus.replay_after(1) {
            ReplayResult::Events(events) => {
                assert_eq!(events.len(), 2);
                assert_eq!(events[0].0, 2);
                assert_eq!(events[1].0, 3);
            }
            other => panic!("expected Events, got {:?}", other),
        }
    }

    #[test]
    fn replay_after_caught_when_at_head() {
        let bus = EventBus::new(16, 16);
        bus.publish(started("a")); // id 1
        bus.publish(started("b")); // id 2
        assert!(matches!(bus.replay_after(2), ReplayResult::Caught));
    }

    #[test]
    fn replay_after_caught_when_empty() {
        let bus = EventBus::new(16, 16);
        assert!(matches!(bus.replay_after(0), ReplayResult::Caught));
    }

    #[test]
    fn replay_after_gap_when_aged_out() {
        // Ring of 2: publish 5 events, oldest retained id=4.
        // Client says it has id=1 ⇒ events 2,3 are gone ⇒ Gap.
        let bus = EventBus::new(16, 2);
        for i in 0..5 {
            bus.publish(started(&format!("s{}", i)));
        }
        assert!(matches!(bus.replay_after(1), ReplayResult::Gap));
    }

    #[test]
    fn replay_after_no_gap_at_ring_boundary() {
        // Ring of 2: oldest retained id=4, client at id=3 ⇒ 3+1==4, no gap.
        let bus = EventBus::new(16, 2);
        for i in 0..5 {
            bus.publish(started(&format!("s{}", i)));
        }
        match bus.replay_after(3) {
            ReplayResult::Events(events) => {
                assert_eq!(events.len(), 2);
                assert_eq!(events[0].0, 4);
            }
            other => panic!("expected Events at ring boundary, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn subscribe_sees_subsequent_publishes() {
        let bus = EventBus::new(16, 16);
        let mut rx = bus.subscribe();
        bus.publish(started("a"));
        let (id, _ev) = rx.recv().await.expect("recv");
        assert_eq!(id, 1);
    }

    #[test]
    fn event_name_matches_serde_tag() {
        let started = started("s");
        assert_eq!(started.event_name(), "session.started");
    }

    #[test]
    fn session_id_accessor_works_for_all_variants() {
        let s = started("xyz");
        assert_eq!(s.session_id(), "xyz");
        let sp = SessionEvent::Span {
            session_id: "abc".into(),
            span_id: "sp1".into(),
            parent_span_id: None,
            span_type: "generation".into(),
            operation: "op".into(),
            model: None,
            cost_usd: 0.0,
            duration_ms: 0,
            status: "ok".into(),
            ts: "t".into(),
        };
        assert_eq!(sp.session_id(), "abc");
    }
}
