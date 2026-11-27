//! gctrl-driver-agents — kernel driver that indexes Claude Code and Codex
//! runs on this machine and reopens them.
//!
//! Spec: `vault/specs/architecture/apps/agent-panel.md`.
//!
//! - [`claude`] reads transcripts and the live registry under `~/.claude`.
//! - [`codex`] reads `threads` from `~/.codex/state_<n>.sqlite`.
//! - [`procs`] probes the process table for liveness and ttys.
//! - [`project`] maps a cwd to a project key and worktree name.
//! - [`index`] assembles runs; [`routes`] serves `/api/agents/*`.
//!
//! Harness stores are read-only to this driver. Focus and launch go through
//! `gctrl-mac-comm`.

pub mod claude;
pub mod codex;
pub mod index;
pub mod model;
pub mod procs;
pub mod project;
pub mod routes;
pub mod text;

pub use index::{AgentIndex, ListOptions, Paths};
pub use model::{AgentRun, Harness, ListResponse, OpenResponse, RunState};

/// Router over the current user's home directory.
pub fn default_router<S: Clone + Send + Sync + 'static>() -> axum::Router<S> {
    routes::router(std::sync::Arc::new(AgentIndex::new(Paths::detect())))
}
