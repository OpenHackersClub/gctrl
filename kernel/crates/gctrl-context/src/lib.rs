//! gctrl-context — Kernel extension for managing agent context.
//!
//! Provides a hybrid DuckDB + filesystem store for documents, configs, and
//! snapshots that agents and humans work from. Content is stored as markdown
//! files with YAML frontmatter; metadata is indexed in DuckDB for querying.
//!
//! Layout:
//!   ~/.local/share/gctrl/context/
//!     config/       — team-shared agent configuration
//!     snapshots/    — point-in-time board/project snapshots
//!     documents/    — specs, decisions, feedback, notes, code

pub mod compact;
pub mod error;
pub mod fs;
pub mod store;

pub use error::ContextError;
pub use store::ContextManager;
