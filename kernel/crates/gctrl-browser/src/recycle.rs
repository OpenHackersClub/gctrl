//! Recycle policy — deciding which Chromium processes to retire.
//!
//! Pure logic, separated from `Pool` so it's straightforward to test.
//! Three signals drive a recycle:
//!
//! - **Idle**: zero active sessions for `recycle_idle_seconds`.
//! - **Aged**: process age ≥ `recycle_max_age_seconds`. Aged processes
//!   are first marked `Draining` (no new sessions) and killed once the
//!   last active session releases.
//! - **Draining + empty**: a previously aged process that is now empty.
//!
//! The pool calls `decide` against the in-memory state and acts on the
//! returned plan. Real time / kill side-effects live in `pool.rs`.

use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChromiumState {
    Active,
    Draining,
}

#[derive(Debug, Clone)]
pub struct ChromiumSnapshot {
    pub id: String,
    pub state: ChromiumState,
    pub created_at: DateTime<Utc>,
    pub last_active_at: DateTime<Utc>,
    pub active_sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecyclePlan {
    /// Mark the chromium as draining; no new sessions assigned to it.
    /// Kill happens when active_sessions drops to 0.
    Drain { id: String, reason: RecycleReason },
    /// Kill the chromium now (active_sessions must be 0).
    Kill { id: String, reason: RecycleReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecycleReason {
    Idle,
    MaxAge,
}

impl RecycleReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecycleReason::Idle => "idle",
            RecycleReason::MaxAge => "max_age",
        }
    }
}

pub struct RecycleConfig {
    pub recycle_idle_seconds: u64,
    pub recycle_max_age_seconds: u64,
}

/// Compute the recycle plan for a snapshot of the pool. Stateless —
/// callers apply the side effects.
pub fn decide(
    chromiums: &[ChromiumSnapshot],
    cfg: &RecycleConfig,
    now: DateTime<Utc>,
) -> Vec<RecyclePlan> {
    let mut plans = Vec::new();
    for c in chromiums {
        let age = (now - c.created_at).num_seconds().max(0) as u64;
        let idle = (now - c.last_active_at).num_seconds().max(0) as u64;

        // Already draining + empty → kill now.
        if c.state == ChromiumState::Draining && c.active_sessions == 0 {
            plans.push(RecyclePlan::Kill {
                id: c.id.clone(),
                reason: RecycleReason::MaxAge,
            });
            continue;
        }

        // Aged: drain (or kill immediately if empty).
        if age >= cfg.recycle_max_age_seconds && c.state == ChromiumState::Active {
            if c.active_sessions == 0 {
                plans.push(RecyclePlan::Kill {
                    id: c.id.clone(),
                    reason: RecycleReason::MaxAge,
                });
            } else {
                plans.push(RecyclePlan::Drain {
                    id: c.id.clone(),
                    reason: RecycleReason::MaxAge,
                });
            }
            continue;
        }

        // Idle: kill (only when empty + active state).
        if c.state == ChromiumState::Active
            && c.active_sessions == 0
            && idle >= cfg.recycle_idle_seconds
        {
            plans.push(RecyclePlan::Kill {
                id: c.id.clone(),
                reason: RecycleReason::Idle,
            });
        }
    }
    plans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RecycleConfig {
        RecycleConfig {
            recycle_idle_seconds: 1800,
            recycle_max_age_seconds: 28_800,
        }
    }

    fn snap(id: &str, state: ChromiumState, age_s: i64, idle_s: i64, sess: u32) -> ChromiumSnapshot {
        let now = Utc::now();
        ChromiumSnapshot {
            id: id.into(),
            state,
            created_at: now - chrono::Duration::seconds(age_s),
            last_active_at: now - chrono::Duration::seconds(idle_s),
            active_sessions: sess,
        }
    }

    #[test]
    fn fresh_chromium_with_sessions_is_kept() {
        let plans = decide(
            &[snap("a", ChromiumState::Active, 60, 5, 2)],
            &cfg(),
            Utc::now(),
        );
        assert!(plans.is_empty());
    }

    #[test]
    fn idle_empty_chromium_killed() {
        let plans = decide(
            &[snap("a", ChromiumState::Active, 60, 1900, 0)],
            &cfg(),
            Utc::now(),
        );
        assert_eq!(
            plans,
            vec![RecyclePlan::Kill {
                id: "a".into(),
                reason: RecycleReason::Idle,
            }]
        );
    }

    #[test]
    fn idle_but_active_chromium_kept() {
        let plans = decide(
            &[snap("a", ChromiumState::Active, 60, 1900, 1)],
            &cfg(),
            Utc::now(),
        );
        assert!(plans.is_empty());
    }

    #[test]
    fn aged_active_chromium_drains() {
        let plans = decide(
            &[snap("a", ChromiumState::Active, 30_000, 5, 3)],
            &cfg(),
            Utc::now(),
        );
        assert_eq!(
            plans,
            vec![RecyclePlan::Drain {
                id: "a".into(),
                reason: RecycleReason::MaxAge,
            }]
        );
    }

    #[test]
    fn aged_empty_chromium_killed_directly() {
        let plans = decide(
            &[snap("a", ChromiumState::Active, 30_000, 5, 0)],
            &cfg(),
            Utc::now(),
        );
        assert_eq!(
            plans,
            vec![RecyclePlan::Kill {
                id: "a".into(),
                reason: RecycleReason::MaxAge,
            }]
        );
    }

    #[test]
    fn draining_empty_chromium_killed() {
        let plans = decide(
            &[snap("a", ChromiumState::Draining, 30_000, 5, 0)],
            &cfg(),
            Utc::now(),
        );
        assert_eq!(
            plans,
            vec![RecyclePlan::Kill {
                id: "a".into(),
                reason: RecycleReason::MaxAge,
            }]
        );
    }

    #[test]
    fn draining_with_sessions_waits() {
        let plans = decide(
            &[snap("a", ChromiumState::Draining, 30_000, 5, 2)],
            &cfg(),
            Utc::now(),
        );
        assert!(plans.is_empty());
    }
}
