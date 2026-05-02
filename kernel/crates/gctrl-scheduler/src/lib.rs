//! gctrl-scheduler — periodic HTTP-callback scheduler for the kernel.
//!
//! A `Schedule` (in `gctrl-core`) is a row in the `schedules` SQLite table that
//! fires an HTTP request to `target_url` whenever its cron expression is due.
//! The runner ([`runner::ScheduleRunner`]) is a tokio fiber spawned by the
//! kernel daemon; the HTTP surface ([`http::router`]) is mounted into the main
//! kernel `Router` so users can list/create/delete/run schedules over the
//! existing `:4318` API.
//!
//! # Why not reuse `gctrl-orch`?
//!
//! `gctrl-orch` is the *agent task dispatcher* — it claims board tasks, runs
//! Claude agents against them, and posts results back. The scheduler is the
//! generic "fire HTTP at this URL on this cron" primitive. They share the
//! polling-loop shape but nothing else; conflating them would tangle agent
//! orchestration with periodic ingest/cleanup/health jobs.

pub mod bootstrap;
pub mod cron;
pub mod exec;
pub mod http;
pub mod redact;
pub mod runner;

pub use bootstrap::ensure_gc_schedule;
pub use runner::ScheduleRunner;
