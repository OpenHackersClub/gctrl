//! gctrl-driver-agents — kernel driver that indexes coding-agent runs on
//! this machine (Claude Code, Codex, Hermes Agent, Pi) and reopens them.
//!
//! Spec: `vault/specs/architecture/apps/agent-panel.md`.
//!
//! - [`adapter`] is the per-harness contract and the shared process matcher.
//! - [`claude`], [`codex`], [`hermes`], [`pi`] are the harness adapters.
//! - [`procs`] probes the process table for liveness and ttys.
//! - [`project`] maps a cwd to a project key and worktree name.
//! - [`index`] assembles runs; [`gather`] moves runs into one terminal
//!   window; [`routes`] serves `/api/agents/*`.
//!
//! Harness stores are read-only to this driver. Focus and launch go through
//! `gctrl-mac-comm`.

pub mod adapter;
pub mod claude;
pub mod codex;
pub mod gather;
pub mod hermes;
pub mod index;
pub mod jsonl;
pub mod kernel_maps;
pub mod map_store;
pub mod model;
pub mod pi;
pub mod procs;
pub mod project;
pub mod routes;
pub mod session_map;
pub mod sqlite_ro;
pub mod text;

pub use index::{AgentIndex, ListOptions, Paths};
pub use model::{AgentRun, Harness, ListResponse, OpenResponse, RunState};

/// Router over the current user's home directory. The index is built on a
/// background thread at kernel start, so the first `/api/agents` call does
/// not pay for the cold scan.
pub fn default_router<S: Clone + Send + Sync + 'static>() -> axum::Router<S> {
    let index = std::sync::Arc::new(AgentIndex::new(Paths::detect()));
    let warm = std::sync::Arc::clone(&index);
    std::thread::Builder::new()
        .name("agents-warmup".into())
        .spawn(move || {
            let started = std::time::Instant::now();
            let runs = warm.refresh(chrono::Utc::now());
            tracing::info!(runs = runs.len(), ms = started.elapsed().as_millis() as u64, "agent index warmed");
        })
        .ok();
    routes::router(index)
}
