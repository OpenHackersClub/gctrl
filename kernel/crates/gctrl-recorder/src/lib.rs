//! gctrl-recorder — L2 of driver-browser.
//!
//! Subscribes to a `gctrl-browser::Pool`'s per-session `CdpFrame`
//! broadcast and structures the relevant CDP messages into typed records:
//!
//! - `Network.requestWillBeSent` / `responseReceived` / `loadingFinished`
//!   → `CapturedRequest`
//! - `Runtime.consoleAPICalled` / `Log.entryAdded` / `Runtime.exceptionThrown`
//!   → `ConsoleEntry`
//! - `Performance.metrics` → `MetricSample`
//!
//! The `ObservabilityReport` shape mirrors the in-app `CDPObserver`
//! fixture being replaced (`apps/gctrl-board/tests/acceptance/fixtures/cdp.ts`)
//! so PR5's migration can swap an HTTP fetch for an in-process method
//! call with no assertion changes.
//!
//! DDL lives in `gctrl-storage::schema` per the Crate Ownership rule
//! (`browser_sessions`, `recorder_requests`, `recorder_console`,
//! `recorder_metrics`, `recorder_cdp_events`). Persistence happens in
//! `gctrl-otel` so the recorder itself stays storage-agnostic and
//! testable without DuckDB.

pub mod capture;
pub mod report;
pub mod structured;

pub use capture::{CaptureSink, CaptureStats};
pub use report::ObservabilityReport;
pub use structured::{CapturedRequest, ConsoleEntry, ConsoleLevel, MetricSample};
