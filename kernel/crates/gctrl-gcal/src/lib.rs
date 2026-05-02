//! gctrl-gcal — Kernel driver for Google Calendar API v3.
//!
//! Holds OAuth refresh-token credentials and exposes a thin client for the
//! handful of Calendar API operations the rest of gctrl needs (list calendars,
//! list/get/create/update events). Deletion is intentionally absent.
//!
//! Auth model (v1): the refresh token is provisioned out-of-band (env vars
//! `GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`, `GCAL_REFRESH_TOKEN`). The client
//! caches the resulting access token in-memory until ~60s before its `expires_in`
//! and refreshes lazily on the next call. A future PR will add an interactive
//! `gctrl uber gcal auth` flow.
//!
//! Permissions are enforced by the HTTP layer (`gctrl-otel/receiver.rs`) via
//! `GCAL_ALLOWED_SCOPES`; this crate is intentionally permission-agnostic so
//! tests can exercise the API surface directly.

pub mod client;
pub mod error;
pub mod model;

pub use client::{GcalClient, GcalCredentials};
pub use error::GcalError;
pub use model::{Calendar, CalendarEvent, EventDateTime, EventInput};
