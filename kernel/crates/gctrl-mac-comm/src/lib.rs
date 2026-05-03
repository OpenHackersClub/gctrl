//! gctrl-mac-comm — Kernel driver for native macOS communication channels.
//!
//! Closes the loop between gctrl-inbox permission requests and the iTerm2 /
//! Terminal.app session that issued them. Exposes a small surface used by the
//! `/api/comm/*` HTTP routes (mounted in `gctrl-otel`) and by the
//! `gctrl terminal` shell command.
//!
//! Public surface:
//! - [`focus`]    — bring the originating terminal session to the foreground.
//! - [`capabilities`] — what the runtime can do (which terminals, automation
//!                     grant state, OS discriminator).
//! - [`validate`] — per-field allowlist regexes for `context.terminal`
//!                  fields. Used at the comm endpoint AND the inbox-message
//!                  intake handler so a single canonical validator covers
//!                  both entry points.
//! - [`RateLimiter`] — per-`session_id` token bucket. The HTTP layer wraps
//!                     focus calls with this.
//!
//! On Linux/Windows, [`focus`] returns [`CommError::NotSupported`] and the
//! routes serialize that as `501 Not Implemented` with a clear body. Building
//! the crate on those platforms is intentionally cheap — no native bindings,
//! no platform-only crates.
//!
//! AppleScript invocation goes through [`osascript::Osascript`], which uses
//! the argv-array form (`-e <a> -e <b>`) — never string concatenation — so
//! validated session IDs cannot break out of the AppleScript string literal.

pub mod capabilities;
pub mod error;
pub mod focus;
pub mod model;
pub mod osascript;
pub mod rate_limit;
pub mod validate;

pub use capabilities::{capabilities, Capabilities};
pub use error::CommError;
pub use focus::focus;
pub use model::{FocusRequest, FocusResponse, TerminalApp, TerminalContext};
pub use rate_limit::RateLimiter;
