//! gctrl-browser — Kernel driver for the CDP attach layer.
//!
//! Owns a pool of long-lived Chromium processes and exposes per-session
//! `BrowserContext`s addressable by a `SessionId`. Clients (Playwright,
//! Puppeteer, chromiumoxide, raw WS) attach to the per-session bearer-gated
//! WebSocket at `/api/browser/sessions/<id>/cdp` and speak Chrome DevTools
//! Protocol directly. The `gctrl-recorder` crate (PR3) subscribes to the
//! frame fanout and structures Network/Runtime/Performance events.
//!
//! This is the lower layer underneath the agent-facing command surface
//! (`snapshot`, `click`, `fill`) defined in
//! [vault/specs/architecture/kernel/browser.md]. The agent commands will
//! eventually be re-implemented on top of this layer.
//!
//! See [vault/specs/implementation/kernel/driver-browser.md] for full
//! architecture, pool semantics, recycle policy, and migration plan.
//!
//! ## Status
//!
//! PR1: types + errors + pool placeholder + config. No Chromium driving yet
//! — `Pool::acquire` returns `BrowserError::Launch` until PR2 wires the
//! `chromiumoxide` integration.

pub mod config;
pub mod error;
pub mod model;
pub mod pool;
pub mod token;

pub use config::BrowserConfig;
pub use error::BrowserError;
pub use model::{
    RecordingOptions, SessionId, SessionInfo, SessionOptions, SessionStatus, Viewport,
};
pub use pool::Pool;
pub use token::{mint_token, Token};
