//! # gctrl-orch — Tier 3 orchestrator / worker
//!
//! Spawns agents for dispatch-eligible tasks (`status=in_progress` +
//! `assignee_type=agent`). Runs as its own `gctrld orch run` daemon so its
//! blast radius is contained: killing the worker does not take the HTTP
//! API down.
//!
//! The claim state machine mirrors `KernelSpec.Orchestrator.step` in
//! `kernel/specs-lean4/KernelSpec/Orchestrator.lean`. Only transitions
//! verified there are emitted by this crate:
//!
//!   Unclaimed → Claimed (dispatchEligible, atomic CAS against SQLite)
//!   Claimed  → Running  (agentLaunched, after subprocess spawn)
//!   Running  → Released (reconciliationTerminal, on clean exit)
//!   Claimed  → Released (dispatchFailed, if spawn fails)
//!   Running  → RetryQueued (agentExitAbnormal, on non-zero exit)
//!
//! Pause/resume, guardrail suspend, and Retry → Running re-dispatch are
//! intentionally out of MVP scope — they exist in the verified spec but
//! aren't wired up yet.

pub mod agent;
pub mod config;
pub mod prompt;
pub mod worker;

pub use config::OrchConfig;
pub use worker::{DispatchOutcome, Worker};
